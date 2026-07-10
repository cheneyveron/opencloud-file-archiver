import { useMessages, useModals } from '@opencloud-eu/web-pkg'
import { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { defaultComponentMocks, getComposableWrapper } from '@opencloud-eu/web-test-helpers'
import { mock } from 'vitest-mock-extended'
import { unref } from 'vue'
import { useUnzipAction } from '../../../src/composables/useUnzipAction'

let askForArchivePasswordMock = vi.fn()

vi.mock('../../../src/composables/useAskForArchivePassword', () => {
  return {
    useAskForArchivePassword: () => ({ askForArchivePassword: askForArchivePasswordMock })
  }
})

describe('unzip action', () => {
  const space = mock<SpaceResource>({ id: 'space-id' })

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/healthz')) {
          return Promise.resolve(jsonResponse({ status: 'ok' }))
        }
        return Promise.resolve(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('isVisible', () => {
    it('is false when file is not a supported archive', () => {
      getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => true }),
        setup: (action) => {
          const resource = mock<Resource>({ name: 'image.png', mimeType: 'image/png' })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeFalsy()
        }
      })
    })

    it('is false for folders even when the folder name looks like an archive', () => {
      getWrapper({
        setup: (action) => {
          const resource = mock<Resource>({
            name: 'archive.zip',
            mimeType: 'application/zip',
            isFolder: true
          })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeFalsy()
        }
      })
    })

    it('is false when the selected archive can not be downloaded', () => {
      getWrapper({
        setup: (action) => {
          const resource = mock<Resource>({
            name: 'archive.zip',
            mimeType: 'application/zip',
            canDownload: () => false
          })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeFalsy()
        }
      })
    })

    it.each([
      ['archive.zip', 'application/zip'],
      ['archive.7z', 'application/octet-stream'],
      ['archive.rar', 'application/vnd.rar'],
      ['archive-rar.bin', 'application/x-rar-compressed'],
      ['archive.tar', 'application/x-tar'],
      ['archive.tar.gz', 'application/gzip'],
      ['archive.tgz', 'application/octet-stream'],
      ['archive.gz', 'application/gzip']
    ])('is true for supported archive %s', (name, mimeType) => {
      getWrapper({
        currentFolder: mock<Resource>({ canUpload: () => true }),
        setup: (action) => {
          const resource = mock<Resource>({ name, mimeType })
          expect(unref(action).isVisible({ space, resources: [resource] })).toBeTruthy()
        }
      })
    })
  })

  describe('handler', () => {
    it('opens a destination picker and submits an async extraction job', async () => {
      const fetchMock = vi.mocked(fetch)

      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'archive-id',
            name: 'archive.zip',
            path: '/archive.zip',
            storageId: 'space-id',
            mimeType: 'application/zip',
            size: 2_000_000_000
          })
          const targetFolder = mock<Resource>({
            id: 'target-folder',
            path: '/target',
            name: 'target',
            storageId: 'target-space-id'
          })

          await unref(action).handler({ space, resources: [resource] })

          const { dispatchModal } = useModals()
          expect(dispatchModal).toHaveBeenCalledTimes(1)
          const modalOptions = vi.mocked(dispatchModal).mock.calls[0][0]
          expect(modalOptions.elementClass).toBe(
            'location-picker-modal file-archiver-location-picker-modal'
          )
          const attrs = modalOptions.customComponentAttrs()
          expect(attrs.submitButtonTitle).toBe('Extract here')

          const callbackFn = attrs.callbackFn as (resources: Resource[]) => void
          callbackFn([targetFolder])

          await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenNthCalledWith(
              2,
              '/archive/api/extractions',
              expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                  source: {
                    spaceId: 'space-id',
                    path: '/archive.zip',
                    name: 'archive.zip',
                    mimeType: 'application/zip',
                    size: 2_000_000_000
                  },
                  destination: {
                    spaceId: 'target-space-id',
                    path: '/target'
                  }
                })
              })
            )
          )
          await vi.waitFor(() => {
            const { showMessage } = useMessages()
            expect(showMessage).toHaveBeenCalledWith({
              title: 'Archive extraction started',
              status: 'passive'
            })
          })
        }
      }).setupPromise
    })

    it('uses a configured service URL', async () => {
      const fetchMock = vi.mocked(fetch)

      await getWrapper({
        applicationConfig: { fileArchiverServiceUrl: 'https://extract.example.test/archive/' },
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'archive-id',
            name: 'archive.7z',
            path: '/archive.7z',
            storageId: 'space-id',
            mimeType: 'application/x-7z-compressed'
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
            expect(fetchMock).toHaveBeenNthCalledWith(
              2,
              'https://extract.example.test/archive/api/extractions',
              expect.anything()
            )
          )
        }
      }).setupPromise
    })

    it('shows an error message if job creation fails', async () => {
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockImplementation((url: string | URL | Request) => {
        if (String(url).endsWith('/healthz')) {
          return Promise.resolve(jsonResponse({ status: 'ok' }))
        }
        return Promise.resolve(
          jsonResponse({ error: 'unsupported archive', code: 'UNSUPPORTED_ARCHIVE' }, 400)
        )
      })

      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'archive-id',
            name: 'archive.zip',
            path: '/archive.zip',
            storageId: 'space-id',
            mimeType: 'application/zip'
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

    it('shows backend installation guidance when the backend is unreachable', async () => {
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockRejectedValue(new TypeError('network failed'))

      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'archive-id',
            name: 'archive.zip',
            path: '/archive.zip',
            storageId: 'space-id',
            mimeType: 'application/zip'
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
            const error = vi.mocked(showErrorMessage).mock.calls[0][0].errors[0] as Error
            expect(error.message).toContain('The File Archiver backend is not installed')
            expect(error.message).toContain(
              'Contact your administrator or follow the backend installation guide.'
            )
          })
          expect(fetchMock).toHaveBeenCalledTimes(1)
        }
      }).setupPromise
    })

    it('prompts for a password and retries when the backend detects encryption', async () => {
      const fetchMock = vi.mocked(fetch)
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
        .mockResolvedValueOnce(
          jsonResponse({ id: 'job-1', status: 'failed', code: 'PASSWORD_REQUIRED' }, 200)
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'job-2', status: 'queued' }, 202))

      await getWrapper({
        setup: async (action) => {
          const resource = mock<Resource>({
            id: 'archive-id',
            name: 'archive.zip',
            path: '/archive.zip',
            storageId: 'space-id',
            mimeType: 'application/zip'
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

          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
          expect(askForArchivePasswordMock).toHaveBeenCalledTimes(1)
          expect(JSON.parse(fetchMock.mock.calls[3][1].body as string).password).toBe(
            'archive-password'
          )
        }
      }).setupPromise
    })
  })
})

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function getWrapper({
  actionFactory = useUnzipAction,
  setup,
  applicationConfig = {},
  currentFolder = mock<Resource>({ path: '/', canUpload: () => true }),
  resources = [],
  archivePassword = 'archive-password'
}: {
  actionFactory?: typeof useUnzipAction
  setup: (
    instance: ReturnType<typeof useUnzipAction>,
    mocks: ReturnType<typeof defaultComponentMocks>
  ) => void
  applicationConfig?: Record<string, unknown>
  currentFolder?: Resource
  resources?: Resource[]
  archivePassword?: string | null
}) {
  askForArchivePasswordMock = vi.fn().mockResolvedValue(archivePassword)
  const mocks = { ...defaultComponentMocks() }

  let setupPromise: Promise<void> = Promise.resolve()

  return {
    wrapper: getComposableWrapper(
      () => {
        const instance = actionFactory({
          archivePasswordPromptMaxAttempts: 1,
          ...applicationConfig
        })
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
