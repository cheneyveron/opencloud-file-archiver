import { FileAction, useMessages, useModals } from '@opencloud-eu/web-pkg'
import { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { defaultComponentMocks, getComposableWrapper } from '@opencloud-eu/web-test-helpers'
import { mock } from 'vitest-mock-extended'
import { unref } from 'vue'
import {
  useCreateArchiveAction,
  useDownloadArchiveAction,
  useDownloadZipAction,
  useEncryptedZipAction,
  useTarGzipAction,
  useZipAction
} from '../../../src/composables/useZipAction'

let askForZipPasswordMock = vi.fn()
let askForArchiveFileNameMock = vi.fn()
let fetchMock = vi.fn()

type FileActionWithChildren = FileAction & { children?: FileAction[] }

vi.mock('../../../src/composables/useAskForZipPassword', () => {
  return {
    useAskForZipPassword: () => ({ askForZipPassword: askForZipPasswordMock })
  }
})

vi.mock('../../../src/composables/useAskForArchiveFileName', () => {
  return {
    useAskForArchiveFileName: () => ({
      askForArchiveFileName: askForArchiveFileNameMock
    })
  }
})

describe('zip action', () => {
  const space = mock<SpaceResource>({ id: 'space-id' })

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'job-1', status: 'queued' })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('isVisible', () => {
    it('is false when no resources are selected', async () => {
      await getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => true }),
        setup: (action) => {
          expect(unref(action).isVisible({ space, resources: [] })).toBeFalsy()
        }
      }).setupPromise
    })

    it('is true without current-folder upload permission because the destination is selected later', async () => {
      await getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => false }),
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => true })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeTruthy()
        }
      }).setupPromise
    })

    it('is false when a selected resource can not be downloaded', async () => {
      await getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => true }),
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => false })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeFalsy()
        }
      }).setupPromise
    })

    it('is true when user can upload and selected resources can be downloaded', async () => {
      await getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => true }),
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => true })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeTruthy()
        }
      }).setupPromise
    })

    it('download action is visible without current-folder upload permission', async () => {
      await getWrapper({
        actionFactory: useDownloadZipAction,
        currentFolder: mock<Resource>({ canUpload: () => false }),
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => true })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeTruthy()
        }
      }).setupPromise
    })

    it('create archive menu exposes archive format actions as children', async () => {
      await getWrapper({
        actionFactory: useCreateArchiveAction,
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => true })
          const unwrappedAction = unref(action) as FileActionWithChildren
          expect(unwrappedAction.label({ space, resources: [resource] })).toBe('Create Archive')
          expect(unwrappedAction.isVisible({ space, resources: [resource] })).toBeTruthy()
          expect(unwrappedAction.children?.map((child) => child.name)).toEqual([
            'create-zip-archive',
            'create-encrypted-zip-archive',
            'create-tar-gzip-archive'
          ])
        }
      }).setupPromise
    })

    it('download archive menu exposes archive format actions as children', async () => {
      await getWrapper({
        actionFactory: useDownloadArchiveAction,
        setup: (action) => {
          const resource = mock<Resource>({ canDownload: () => true })
          const unwrappedAction = unref(action) as FileActionWithChildren
          expect(unwrappedAction.label({ space, resources: [resource] })).toBe('Download Archive')
          expect(unwrappedAction.isVisible({ space, resources: [resource] })).toBeTruthy()
          expect(unwrappedAction.children?.map((child) => child.name)).toEqual([
            'download-zip-archive',
            'download-encrypted-zip-archive',
            'download-tar-gzip-archive'
          ])
        }
      }).setupPromise
    })
  })

  describe('handler', () => {
    it('opens a destination picker and creates a backend compression job for a selected file', async () => {
      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'report-id',
            name: 'report.txt',
            path: '/report.txt',
            storageId: 'space-id',
            isFolder: false,
            mimeType: 'text/plain',
            size: 12
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })

          const { dispatchModal } = useModals()
          expect(dispatchModal).toHaveBeenCalledTimes(1)
          const attrs = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
          expect(attrs.chooseFileName).toBe(true)
          expect(attrs.chooseFileNameSuggestion).toBe('report.zip')
          const callbackFn = attrs.callbackFn as (
            resources: Resource[],
            options?: { fileName?: string }
          ) => void
          callbackFn([targetFolder], { fileName: 'custom.zip' })

          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
          expect(askForArchiveFileNameMock).not.toHaveBeenCalled()
          expect(fetchMock).toHaveBeenCalledWith(
            '/archive/api/compressions',
            expect.objectContaining({
              method: 'POST',
              body: JSON.stringify({
                format: 'zip',
                sources: [
                  {
                    spaceId: 'space-id',
                    path: '/report.txt',
                    name: 'report.txt',
                    mimeType: 'text/plain',
                    size: 12
                  }
                ],
                output: {
                  mode: 'save',
                  destination: {
                    spaceId: 'target-space-id',
                    folderPath: '/target',
                    fileName: 'custom.zip'
                  }
                },
                conflicts: 'keep-both'
              })
            })
          )
          await vi.waitFor(() => {
            const { showMessage } = useMessages()
            expect(showMessage).toHaveBeenCalledWith({
              title: 'Archive creation started',
              status: 'passive'
            })
          })
        }
      }).setupPromise
    })

    it('asks for an archive file name when the location picker returns a legacy payload', async () => {
      await getWrapper({
        archiveFileName: 'fallback-name.zip',
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'report-id',
            name: 'report.txt',
            path: '/report.txt',
            storageId: 'space-id',
            isFolder: false,
            mimeType: 'text/plain'
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })

          const { dispatchModal } = useModals()
          const callbackFn = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
            .callbackFn as (resources: Resource[]) => void
          callbackFn([targetFolder])

          await vi.waitFor(() =>
            expect(askForArchiveFileNameMock).toHaveBeenCalledWith('report.zip')
          )
          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
          expect(
            JSON.parse(fetchMock.mock.calls[0][1].body as string).output.destination.fileName
          ).toBe('fallback-name.zip')
        }
      }).setupPromise
    })

    it('does not create an archive when the fallback file name prompt is cancelled', async () => {
      await getWrapper({
        archiveFileName: null,
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'report-id',
            name: 'report.txt',
            path: '/report.txt',
            storageId: 'space-id',
            isFolder: false
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })
          const { dispatchModal } = useModals()
          const callbackFn = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
            .callbackFn as (resources: Resource[]) => void
          callbackFn([targetFolder])

          await vi.waitFor(() => expect(askForArchiveFileNameMock).toHaveBeenCalled())
          expect(fetchMock).not.toHaveBeenCalled()
        }
      }).setupPromise
    })

    it('creates archive.zip when multiple resources are selected', async () => {
      await getWrapper({
        setup: async (action) => {
          const first = mock<Resource>({
            id: 'one-id',
            name: 'one.txt',
            path: '/one.txt',
            storageId: 'space-id',
            isFolder: false
          })
          const second = mock<Resource>({
            id: 'two-id',
            name: 'two.txt',
            path: '/two.txt',
            storageId: 'space-id',
            isFolder: false
          })

          await unref(action).handler({ space, resources: [first, second] })

          const { dispatchModal } = useModals()
          const attrs = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
          expect(attrs.chooseFileNameSuggestion).toBe('archive.zip')
        }
      }).setupPromise
    })

    it('resolves archive name conflicts in the current folder', async () => {
      await getWrapper({
        resources: [mock<Resource>({ name: 'archive.zip' })],
        setup: async (action) => {
          const first = mock<Resource>({
            id: 'one-id',
            name: 'one.txt',
            path: '/one.txt',
            storageId: 'space-id',
            isFolder: false
          })
          const second = mock<Resource>({
            id: 'two-id',
            name: 'two.txt',
            path: '/two.txt',
            storageId: 'space-id',
            isFolder: false
          })

          await unref(action).handler({ space, resources: [first, second] })

          const { dispatchModal } = useModals()
          const attrs = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
          expect(attrs.chooseFileNameSuggestion).toBe('archive (1).zip')
        }
      }).setupPromise
    })

    it('shows an error message if archive creation fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'failed to create archive' })
      })

      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'folder-id',
            name: 'folder',
            path: '/folder',
            storageId: 'space-id',
            isFolder: true
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })
          await unref(action).handler({ space, resources: [resource] })
          const { dispatchModal } = useModals()
          const callbackFn = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
            .callbackFn as (resources: Resource[]) => void
          callbackFn([targetFolder])

          await vi.waitFor(() => {
            const { showErrorMessage } = useMessages()
            expect(showErrorMessage).toHaveBeenCalledTimes(1)
          })
        }
      }).setupPromise
    })

    it('creates an encrypted zip job using the entered password', async () => {
      await getWrapper({
        actionFactory: useEncryptedZipAction,
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'secret-id',
            name: 'secret.txt',
            path: '/secret.txt',
            storageId: 'space-id',
            isFolder: false
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })
          const { dispatchModal } = useModals()
          const callbackFn = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
            .callbackFn as (resources: Resource[]) => void
          callbackFn([targetFolder])

          expect(askForZipPasswordMock).toHaveBeenCalledTimes(1)
          await vi.waitFor(() => {
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).encryption).toEqual({
              method: 'zip-aes256',
              password: 'zip-password'
            })
          })
        }
      }).setupPromise
    })

    it('does not create an encrypted archive when the password prompt is cancelled', async () => {
      await getWrapper({
        actionFactory: useEncryptedZipAction,
        zipPassword: null,
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'secret-id',
            name: 'secret.txt',
            path: '/secret.txt',
            isFolder: false
          })

          await unref(action).handler({ space, resources: [resource] })

          expect(fetchMock).not.toHaveBeenCalled()
        }
      }).setupPromise
    })

    it('creates a direct download job and opens its download URL', async () => {
      const assignMock = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)

      await getWrapper({
        actionFactory: useDownloadZipAction,
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'report-id',
            name: 'report.txt',
            path: '/report.txt',
            isFolder: false
          })

          await unref(action).handler({ space, resources: [resource] })

          expect(JSON.parse(fetchMock.mock.calls[0][1].body).output).toEqual({
            mode: 'download',
            fileName: 'report.zip'
          })
          expect(assignMock).toHaveBeenCalledWith('/archive/api/jobs/job-1/download')
        }
      }).setupPromise

      assignMock.mockRestore()
    })

    it('creates tar.gz archives through the backend', async () => {
      await getWrapper({
        actionFactory: useTarGzipAction,
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'folder-id',
            name: 'folder',
            path: '/folder',
            storageId: 'space-id',
            isFolder: true
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })
          const { dispatchModal } = useModals()
          const attrs = vi.mocked(dispatchModal).mock.calls[0][0].customComponentAttrs()
          expect(attrs.chooseFileNameSuggestion).toBe('folder.tar.gz')
          const callbackFn = attrs.callbackFn as (
            resources: Resource[],
            options?: { fileName?: string }
          ) => void
          callbackFn([targetFolder], { fileName: 'folder.tar.gz' })

          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
          expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).format).toBe('tar.gz')
        }
      }).setupPromise
    })
  })
})

function getWrapper({
  actionFactory = useZipAction,
  setup,
  currentFolder = mock<Resource>({ path: '/Personal', canUpload: () => true }),
  resources = [],
  zipPassword = 'zip-password',
  archiveFileName = 'archive.zip'
}: {
  actionFactory?: (
    applicationConfig?: Parameters<typeof useZipAction>[0]
  ) => ReturnType<typeof useZipAction>
  setup: (
    instance: ReturnType<typeof useZipAction>,
    mocks: ReturnType<typeof defaultComponentMocks>
  ) => void
  currentFolder?: Resource
  resources?: Resource[]
  zipPassword?: string | null
  archiveFileName?: string | null
}) {
  askForZipPasswordMock = vi.fn().mockResolvedValue(zipPassword)
  askForArchiveFileNameMock = vi.fn().mockResolvedValue(archiveFileName)

  const mocks = { ...defaultComponentMocks() }
  let setupPromise: Promise<void> = Promise.resolve()

  return {
    wrapper: getComposableWrapper(
      () => {
        const instance = actionFactory()
        setupPromise = Promise.resolve(setup(instance, mocks))
      },
      {
        mocks,
        provide: mocks,
        pluginOptions: {
          piniaOptions: {
            resourcesStore: { currentFolder, resources },
            spacesState: {
              spaces: [
                mock<SpaceResource>({ id: 'space-id', storageId: 'space-id' }),
                mock<SpaceResource>({ id: 'target-space-id', storageId: 'target-space-id' })
              ]
            }
          }
        }
      }
    ),
    setupPromise
  }
}
