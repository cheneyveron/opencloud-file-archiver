import {
  AppConfigObject,
  FileAction,
  FileActionOptions,
  LocationPickerModal,
  useFolderLink,
  useGetMatchingSpace,
  useMessages,
  useModals,
  useRequestHeaders,
  useResourcesStore
} from '@opencloud-eu/web-pkg'
import { Resource } from '@opencloud-eu/web-client'
import { computed, markRaw, unref } from 'vue'
import { useGettext } from 'vue3-gettext'
import { useAskForArchiveFileName } from './useAskForArchiveFileName'
import { useAskForZipPassword } from './useAskForZipPassword'

const DEFAULT_SERVICE_URL = '/archive'
const DEFAULT_ARCHIVE_NAME = 'archive'

type ArchiveFormat = 'zip' | 'tar.gz'

type ArchiveConfig = AppConfigObject & {
  fileArchiverServiceUrl?: string
  archiveServiceUrl?: string
  unarchiveServiceUrl?: string
}

type ZipActionOptions = {
  encrypted?: boolean
  download?: boolean
  format?: ArchiveFormat
}

type CompressionJob = {
  id: string
  output?: {
    downloadUrl?: string
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function getServiceUrl(applicationConfig: ArchiveConfig) {
  return trimTrailingSlash(
    applicationConfig.fileArchiverServiceUrl ||
      applicationConfig.archiveServiceUrl ||
      applicationConfig.unarchiveServiceUrl ||
      DEFAULT_SERVICE_URL
  )
}

function getResourceName(resource: Resource) {
  return resource.name || resource.path.split('/').filter(Boolean).pop() || DEFAULT_ARCHIVE_NAME
}

function getArchiveExtension(format: ArchiveFormat) {
  return format === 'tar.gz' ? 'tar.gz' : 'zip'
}

function getArchiveBaseName(resources: Resource[]) {
  if (resources.length !== 1) {
    return DEFAULT_ARCHIVE_NAME
  }

  const resource = resources[0]
  const resourceName = getResourceName(resource)
  if (resource.isFolder) {
    return resourceName
  }

  const extensionStart = resourceName.lastIndexOf('.')
  return extensionStart > 0 ? resourceName.slice(0, extensionStart) : resourceName
}

function getArchiveFileName(
  resources: Resource[],
  existingResources: Resource[],
  format: ArchiveFormat
) {
  const baseName = getArchiveBaseName(resources).trim() || DEFAULT_ARCHIVE_NAME
  const extension = getArchiveExtension(format)
  const existingResourceNames = new Set(
    (existingResources || []).map((resource) => resource.name).filter(Boolean)
  )
  let iteration = 0
  let fileName = ''

  do {
    const suffix = iteration === 0 ? '' : ` (${iteration})`
    fileName = `${baseName}${suffix}.${extension}`
    iteration += 1
  } while (existingResourceNames.has(fileName))

  return fileName
}

function ensureArchiveFileName(fileName: string, format: ArchiveFormat) {
  const extension = `.${getArchiveExtension(format)}`
  const trimmed = fileName.trim() || DEFAULT_ARCHIVE_NAME
  return trimmed.toLowerCase().endsWith(extension) ? trimmed : `${trimmed}${extension}`
}

function getDownloadUrl(applicationConfig: ArchiveConfig, job: CompressionJob) {
  const downloadUrl = job.output?.downloadUrl || `/api/jobs/${encodeURIComponent(job.id)}/download`
  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl
  }

  const serviceRelativePath = downloadUrl.startsWith('/archive/')
    ? downloadUrl.slice('/archive'.length)
    : downloadUrl
  return `${getServiceUrl(applicationConfig)}${serviceRelativePath}`
}

const useCreateZipAction = (
  applicationConfig: ArchiveConfig = {},
  { encrypted = false, download = false, format = 'zip' }: ZipActionOptions = {}
) => {
  const { $gettext } = useGettext()
  const resourcesStore = useResourcesStore()
  const requestHeaders = useRequestHeaders()
  const { showErrorMessage, showMessage } = useMessages()
  const { askForArchiveFileName } = useAskForArchiveFileName()
  const { askForZipPassword } = useAskForZipPassword()
  const { dispatchModal } = useModals()
  const { getParentFolderLink } = useFolderLink()
  const { getMatchingSpace } = useGetMatchingSpace()

  async function requestJson<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(`${getServiceUrl(applicationConfig)}${path}`, {
      ...init,
      headers: {
        ...unref(requestHeaders.headers),
        ...(init.headers || {}),
        Accept: 'application/json'
      }
    })
    const payload = await response.json().catch((): undefined => undefined)
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error)
          : $gettext('Archive creation failed')
      throw new Error(message)
    }
    return payload as T
  }

  async function createCompressionJob({
    space,
    resources,
    archiveFileName,
    targetFolder,
    password
  }: FileActionOptions & {
    archiveFileName: string
    targetFolder?: Resource
    password?: string
  }) {
    if (!download && !targetFolder) {
      throw new Error($gettext('Destination folder is required'))
    }

    const targetSpace = targetFolder ? getMatchingSpace(targetFolder) : undefined
    const output = download
      ? {
          mode: 'download',
          fileName: archiveFileName
        }
      : {
          mode: 'save',
          destination: {
            spaceId: targetSpace?.id,
            folderPath: targetFolder?.path,
            fileName: archiveFileName
          }
        }

    return requestJson<CompressionJob>('/api/compressions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        format,
        sources: resources.map((resource) => ({
          spaceId: unref(space).id,
          path: resource.path,
          name: getResourceName(resource),
          mimeType: resource.mimeType,
          size: Number(resource.size || 0)
        })),
        ...(password && {
          encryption: {
            method: 'zip-aes256',
            password
          }
        }),
        output,
        conflicts: 'keep-both'
      })
    })
  }

  async function createSavedArchive({
    space,
    resources,
    targetFolder,
    archiveFileName,
    password
  }: FileActionOptions & {
    targetFolder: Resource
    archiveFileName: string
    password?: string
  }) {
    try {
      await createCompressionJob({
        space,
        resources,
        archiveFileName,
        targetFolder,
        password
      })

      showMessage({
        title: $gettext('Archive creation started'),
        status: 'passive'
      })
    } catch (error) {
      showErrorMessage({
        title: $gettext('Failed to create archive'),
        errors: [error]
      })
    }
  }

  async function createDownloadArchive({
    space,
    resources,
    archiveFileName,
    password
  }: FileActionOptions & {
    archiveFileName: string
    password?: string
  }) {
    const job = await createCompressionJob({ space, resources, archiveFileName, password })
    window.location.assign(getDownloadUrl(applicationConfig, job))
  }

  async function actionHandler(args: FileActionOptions) {
    const { space, resources = [] } = args
    if (!resources.length) {
      return
    }

    const password = encrypted ? await askForZipPassword() : undefined
    if (encrypted && !password) {
      return
    }

    const archiveFileName = getArchiveFileName(resources, resourcesStore.resources, format)
    if (download) {
      try {
        await createDownloadArchive({ space, resources, archiveFileName, password })
      } catch (error) {
        showErrorMessage({ title: $gettext('Failed to create archive'), errors: [error] })
      }
      return
    }

    resourcesStore.setSelection(resources.map(({ id }) => id))
    dispatchModal({
      elementClass: 'location-picker-modal',
      title: encrypted
        ? $gettext('Create encrypted ZIP archive')
        : format === 'tar.gz'
          ? $gettext('Create tar.gz archive')
          : $gettext('Create ZIP archive'),
      customComponent: markRaw(LocationPickerModal),
      hideActions: true,
      customComponentAttrs: () => ({
        submitButtonTitle: $gettext('Create here'),
        parentFolderLink: getParentFolderLink(resources[0]),
        chooseFileName: true,
        chooseFileNameSuggestion: archiveFileName,
        callbackFn: (targetResources: Resource[], options?: { fileName?: string }) => {
          const targetFolder = targetResources[0]
          void (async () => {
            const selectedFileName =
              typeof options?.fileName === 'string'
                ? options.fileName
                : await askForArchiveFileName(archiveFileName)
            if (!selectedFileName) {
              return
            }

            const fileName = ensureArchiveFileName(selectedFileName, format)
            await createSavedArchive({
              space,
              resources,
              targetFolder,
              archiveFileName: fileName,
              password
            })
          })()
        }
      }),
      focusTrapInitial: false
    })
  }

  const action = computed<FileAction>(() => {
    const isTarGzip = format === 'tar.gz'
    return {
      name: download
        ? encrypted
          ? 'download-encrypted-zip-archive'
          : isTarGzip
            ? 'download-tar-gzip-archive'
            : 'download-zip-archive'
        : encrypted
          ? 'create-encrypted-zip-archive'
          : isTarGzip
            ? 'create-tar-gzip-archive'
            : 'create-zip-archive',
      icon: encrypted ? 'lock' : download ? 'download' : 'inbox-archive',
      handler: actionHandler,
      label: () => {
        if (download) {
          if (encrypted) {
            return $gettext('Download encrypted ZIP archive')
          }
          return isTarGzip ? $gettext('Download tar.gz archive') : $gettext('Download ZIP archive')
        }
        if (encrypted) {
          return $gettext('Create encrypted ZIP archive...')
        }
        return isTarGzip ? $gettext('Create tar.gz archive...') : $gettext('Create ZIP archive...')
      },
      isVisible: ({ resources = [] }) => {
        if (!resources.length) {
          return false
        }
        return resources.every((resource) => resource.canDownload?.() !== false)
      },
      componentType: 'button',
      class: download
        ? encrypted
          ? 'oc-files-actions-download-encrypted-zip-archive'
          : isTarGzip
            ? 'oc-files-actions-download-tar-gzip-archive'
            : 'oc-files-actions-download-zip-archive'
        : encrypted
          ? 'oc-files-actions-create-encrypted-zip-archive'
          : isTarGzip
            ? 'oc-files-actions-create-tar-gzip-archive'
            : 'oc-files-actions-create-zip-archive'
    }
  })

  return action
}

export const useZipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig)

export const useEncryptedZipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig, { encrypted: true })

export const useTarGzipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig, { format: 'tar.gz' })

export const useDownloadZipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig, { download: true })

export const useDownloadEncryptedZipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig, { encrypted: true, download: true })

export const useDownloadTarGzipAction = (applicationConfig: ArchiveConfig = {}) =>
  useCreateZipAction(applicationConfig, { format: 'tar.gz', download: true })

export const useCreateArchiveAction = (applicationConfig: ArchiveConfig = {}) => {
  const { $gettext } = useGettext()
  const zipAction = useZipAction(applicationConfig)
  const encryptedZipAction = useEncryptedZipAction(applicationConfig)
  const tarGzipAction = useTarGzipAction(applicationConfig)

  return computed<FileAction>(() => {
    const children = [unref(zipAction), unref(encryptedZipAction), unref(tarGzipAction)]
    return {
      name: 'create-archive',
      icon: 'inbox-archive',
      label: () => $gettext('Create Archive'),
      isVisible: (options) => children.some((action) => action.isVisible(options)),
      children,
      class: 'oc-files-actions-create-archive'
    }
  })
}

export const useDownloadArchiveAction = (applicationConfig: ArchiveConfig = {}) => {
  const { $gettext } = useGettext()
  const zipAction = useDownloadZipAction(applicationConfig)
  const encryptedZipAction = useDownloadEncryptedZipAction(applicationConfig)
  const tarGzipAction = useDownloadTarGzipAction(applicationConfig)

  return computed<FileAction>(() => {
    const children = [unref(zipAction), unref(encryptedZipAction), unref(tarGzipAction)]
    return {
      name: 'download-archive',
      icon: 'download',
      label: () => $gettext('Download Archive'),
      isVisible: (options) => children.some((action) => action.isVisible(options)),
      children,
      class: 'oc-files-actions-download-archive'
    }
  })
}
