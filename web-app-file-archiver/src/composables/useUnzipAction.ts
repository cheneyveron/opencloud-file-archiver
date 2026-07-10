import {
  FileAction,
  FileActionOptions,
  LocationPickerModal,
  useFolderLink,
  useGetMatchingSpace,
  useMessages,
  useModals,
  useResourcesStore
} from '@opencloud-eu/web-pkg'
import { Resource } from '@opencloud-eu/web-client'
import { computed, markRaw, unref } from 'vue'
import { useGettext } from 'vue3-gettext'
import { useAskForArchivePassword } from './useAskForArchivePassword'
import { ArchiveServiceConfig, useArchiveService } from './useArchiveService'

type ExtractionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

type ExtractionJob = {
  id: string
  status: ExtractionJobStatus
  stage?: string
  code?: string
  error?: string
  processedEntries?: number
  totalEntries?: number
}

type ExtractionConfig = ArchiveServiceConfig & {
  archivePasswordPromptMaxAttempts?: number
  archivePasswordPromptPollIntervalMs?: number
}

const PASSWORD_REQUIRED_CODE = 'PASSWORD_REQUIRED'
const PASSWORD_PROMPT_POLL_INTERVAL_MS = 1000
const PASSWORD_PROMPT_MAX_ATTEMPTS = 120

const SUPPORTED_MIME_TYPES = [
  'application/gzip',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-compressed-tar',
  'application/x-gzip',
  'application/x-rar',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/zip'
]

const SUPPORTED_EXTENSIONS = ['7z', 'gz', 'rar', 'tar', 'tar.gz', 'tgz', 'zip']

function getPasswordPromptPollIntervalMs(applicationConfig: ExtractionConfig) {
  return Number(
    applicationConfig.archivePasswordPromptPollIntervalMs ?? PASSWORD_PROMPT_POLL_INTERVAL_MS
  )
}

function getPasswordPromptMaxAttempts(applicationConfig: ExtractionConfig) {
  return Number(applicationConfig.archivePasswordPromptMaxAttempts ?? PASSWORD_PROMPT_MAX_ATTEMPTS)
}

function getResourceName(resource: Resource) {
  return resource.name || resource.path.split('/').filter(Boolean).pop() || 'archive'
}

function getResourceExtension(resource: Resource) {
  const name = getResourceName(resource).toLowerCase()
  if (name.endsWith('.tar.gz')) {
    return 'tar.gz'
  }

  return name.split('.').pop() || ''
}

function isSupportedArchive(resource: Resource) {
  if (resource.isFolder === true) {
    return false
  }

  if (SUPPORTED_MIME_TYPES.includes(resource.mimeType)) {
    return true
  }

  return SUPPORTED_EXTENSIONS.includes(getResourceExtension(resource))
}

const useCreateUnzipAction = (applicationConfig: ExtractionConfig = {}) => {
  const { $gettext } = useGettext()
  const resourcesStore = useResourcesStore()
  const { requestJson } = useArchiveService(applicationConfig)
  const { showErrorMessage, showMessage } = useMessages()
  const { dispatchModal } = useModals()
  const { getParentFolderLink } = useFolderLink()
  const { getMatchingSpace } = useGetMatchingSpace()
  const { askForArchivePassword } = useAskForArchivePassword()

  async function createExtractionJob({
    sourceSpace,
    archive,
    targetFolder,
    password
  }: {
    sourceSpace: FileActionOptions['space']
    archive: Resource
    targetFolder: Resource
    password?: string
  }) {
    const targetSpace = getMatchingSpace(targetFolder)
    return requestJson<ExtractionJob>('/api/extractions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: {
          spaceId: unref(sourceSpace).id,
          path: archive.path,
          name: getResourceName(archive),
          mimeType: archive.mimeType,
          size: Number(archive.size || 0)
        },
        destination: {
          spaceId: targetSpace.id,
          path: targetFolder.path
        },
        password
      })
    })
  }

  async function getExtractionJob(jobId: string) {
    return requestJson<ExtractionJob>(`/api/jobs/${encodeURIComponent(jobId)}`)
  }

  async function waitForPasswordRequired(jobId: string) {
    const maxAttempts = getPasswordPromptMaxAttempts(applicationConfig)
    const pollInterval = getPasswordPromptPollIntervalMs(applicationConfig)
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, pollInterval))
      }
      const job = await getExtractionJob(jobId)
      if (job.status === 'failed') {
        return job.code === PASSWORD_REQUIRED_CODE
      }
      if (job.status === 'succeeded' || job.status === 'cancelled') {
        return false
      }
    }

    return false
  }

  async function retryWithPasswordIfRequired({
    sourceSpace,
    archive,
    targetFolder,
    job
  }: {
    sourceSpace: FileActionOptions['space']
    archive: Resource
    targetFolder: Resource
    job: ExtractionJob
  }) {
    const passwordRequired = await waitForPasswordRequired(job.id)
    if (!passwordRequired) {
      return
    }

    const password = await askForArchivePassword()
    if (!password) {
      return
    }

    await createExtractionJob({ sourceSpace, archive, targetFolder, password })
    showMessage({
      title: $gettext('Archive extraction started'),
      status: 'passive'
    })
  }

  async function onLocationPicked({
    sourceSpace,
    archive,
    targetFolder,
    password
  }: {
    sourceSpace: FileActionOptions['space']
    archive: Resource
    targetFolder: Resource
    password?: string
  }) {
    try {
      const job = await createExtractionJob({ sourceSpace, archive, targetFolder, password })

      showMessage({
        title: $gettext('Archive extraction started'),
        status: 'passive'
      })

      if (!password) {
        void retryWithPasswordIfRequired({ sourceSpace, archive, targetFolder, job }).catch(
          (error) => {
            showErrorMessage({ title: $gettext('Failed to extract archive'), errors: [error] })
          }
        )
      }
    } catch (error) {
      showErrorMessage({ title: $gettext('Failed to extract archive'), errors: [error] })
    }
  }

  async function handler({ space, resources = [] }: FileActionOptions) {
    try {
      if (resources.length !== 1) {
        return
      }

      const archive = resources[0]

      resourcesStore.setSelection(resources.map(({ id }) => id))
      dispatchModal({
        elementClass: 'location-picker-modal file-archiver-location-picker-modal',
        title: $gettext('Extract archive to'),
        customComponent: markRaw(LocationPickerModal),
        hideActions: true,
        customComponentAttrs: () => ({
          submitButtonTitle: $gettext('Extract here'),
          parentFolderLink: getParentFolderLink(archive),
          callbackFn: (targetResources: Resource[]) => {
            const targetFolder = targetResources[0]
            void onLocationPicked({ sourceSpace: space, archive, targetFolder })
          }
        }),
        focusTrapInitial: false
      })
    } catch (error) {
      showErrorMessage({ title: $gettext('Failed to extract archive'), errors: [error] })
    }
  }

  const action = computed<FileAction>(() => {
    return {
      name: 'unzip-archive',
      icon: 'inbox-unarchive',
      handler,
      label: () => {
        return $gettext('Extract to...')
      },
      isVisible: ({ resources }) => {
        if (resources.length !== 1) {
          return false
        }
        if (resources[0].canDownload?.() === false) {
          return false
        }
        return isSupportedArchive(resources[0])
      },
      componentType: 'button',
      class: 'oc-files-actions-unzip-archive'
    }
  })

  return action
}

export const useUnzipAction = (applicationConfig: ExtractionConfig = {}) =>
  useCreateUnzipAction(applicationConfig)
