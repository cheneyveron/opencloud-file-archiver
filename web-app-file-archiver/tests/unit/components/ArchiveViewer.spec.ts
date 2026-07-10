import { mount } from '@vue/test-utils'
import { Resource, SpaceResource } from '@opencloud-eu/web-client'
import ArchiveViewer from '../../../src/components/ArchiveViewer.vue'

const dispatchModalMock = vi.fn()
const showMessageMock = vi.fn()
const showErrorMessageMock = vi.fn()
const askForArchivePasswordMock = vi.fn()

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({
    $gettext: (value: string, params?: Record<string, string>) => {
      if (!params) {
        return value
      }
      return Object.entries(params).reduce(
        (text, [key, replacement]) => text.replace(`%{${key}}`, replacement),
        value
      )
    }
  })
}))

vi.mock('@opencloud-eu/web-pkg', () => ({
  LocationPickerModal: { name: 'LocationPickerModal', template: '<div />' },
  useFolderLink: () => ({ getParentFolderLink: () => ({ path: '/files' }) }),
  useGetMatchingSpace: () => ({ getMatchingSpace: (resource: { storageId?: string }) => ({ id: resource.storageId || 'target-space-id' }) }),
  useMessages: () => ({ showMessage: showMessageMock, showErrorMessage: showErrorMessageMock }),
  useModals: () => ({ dispatchModal: dispatchModalMock }),
  useRequestHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } })
}))

vi.mock('../../../src/composables/useAskForArchivePassword', () => ({
  useAskForArchivePassword: () => ({ askForArchivePassword: askForArchivePasswordMock })
}))

describe('ArchiveViewer', () => {
  beforeEach(() => {
    dispatchModalMock.mockReset()
    showMessageMock.mockReset()
    showErrorMessageMock.mockReset()
    askForArchivePasswordMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('creates a preview, navigates folders and previews text content', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      return Promise.resolve(routeFetch(url, init, { rootEntries: [folderEntry()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountViewer()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await buttonByText(wrapper, 'dir').trigger('click')
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/entries?path=dir'))).toBe(
        true
      )
      expect(wrapper.text()).toContain('file.txt')
      expect(wrapper.text()).toContain('18 B')
      expect(wrapper.text()).toContain('Modified')
      expect(wrapper.text()).toContain('2026')
    })

    await buttonByText(wrapper, 'file.txt').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('hello from archive'))

    expect(fetchMock.mock.calls[1]).toEqual([
      '/archive/api/previews',
      expect.objectContaining({ method: 'POST' })
    ])
    expect(fetchMock.mock.calls).toEqual(
      expect.arrayContaining([
        [
          '/archive/api/previews/preview-1/entries?path=dir',
          expect.anything()
        ],
        [
          '/archive/api/previews/preview-1/entries/file-entry/content',
          expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer test-token' })
          })
        ]
      ])
    )
  })

  it('extracts selected archive entries through the async extraction API', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      return Promise.resolve(routeFetch(url, init, { rootEntries: [textEntry()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountViewer()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    await checkboxes[1].setValue(true)
    await buttonByText(wrapper, 'Extract selected...').trigger('click')

    const modalOptions = dispatchModalMock.mock.calls[0][0]
    expect(modalOptions.elementClass).toBe(
      'location-picker-modal file-archiver-location-picker-modal'
    )
    const attrs = modalOptions.customComponentAttrs()
    attrs.callbackFn([{ path: '/target', storageId: 'target-space-id' }])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls).toEqual(
        expect.arrayContaining([
          [
            '/archive/api/extractions',
            expect.objectContaining({
              method: 'POST',
              body: JSON.stringify({
                source: {
                  spaceId: 'space-id',
                  path: '/archive.zip',
                  name: 'archive.zip',
                  mimeType: 'application/zip',
                  size: 1024
                },
                destination: {
                  spaceId: 'target-space-id',
                  path: '/target'
                },
                includePaths: ['dir/file.txt'],
                conflicts: 'keep-both'
              })
            })
          ]
        ])
      )
      expect(showMessageMock).toHaveBeenCalledWith({
        title: 'Archive extraction started',
        status: 'passive'
      })
    })
  })

  it('extracts a single archive entry from the row action menu', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      return Promise.resolve(routeFetch(url, init, { rootEntries: [textEntry()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountViewer()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await buttonByText(wrapper, 'Extract To...').trigger('click')
    const attrs = dispatchModalMock.mock.calls[0][0].customComponentAttrs()
    attrs.callbackFn([{ path: '/target', storageId: 'target-space-id' }])

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls).toEqual(
        expect.arrayContaining([
          [
            '/archive/api/extractions',
            expect.objectContaining({
              method: 'POST',
              body: expect.stringContaining('"includePaths":["dir/file.txt"]')
            })
          ]
        ])
      )
    })
  })

  it('creates a direct download URL for a single archive entry', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      return Promise.resolve(routeFetch(url, init, { rootEntries: [textEntry()] }))
    })
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountViewer()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await buttonByText(wrapper, 'Download').trigger('click')

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls).toEqual(
        expect.arrayContaining([
          [
            '/archive/api/previews/preview-1/entries/file-entry/download',
            expect.objectContaining({ method: 'POST' })
          ]
        ])
      )
      expect(clickMock).toHaveBeenCalled()
    })
  })

  it('renders backend installation guidance when the backend is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountViewer()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('The File Archiver backend is not installed')
      expect(wrapper.text()).toContain(
        'Contact your administrator or follow the backend installation guide.'
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/archive/healthz', expect.anything())
  })
})

function mountViewer() {
  return mount(ArchiveViewer, {
    props: {
      resource: {
        id: 'archive-id',
        name: 'archive.zip',
        path: '/archive.zip',
        mimeType: 'application/zip',
        size: 1024
      } as unknown as Resource,
      space: { id: 'space-id' } as unknown as SpaceResource,
      applicationConfig: {}
    },
    global: {
      mocks: {
        $gettext: (value: string) => value
      },
      stubs: {
        'oc-button': {
          template: `<button type="button" @click="$emit('click', $event)"><slot /></button>`
        },
        'oc-drop': { template: '<div><slot /></div>' },
        'oc-list': { template: '<ul><slot /></ul>' },
        'oc-icon': { template: '<span />' },
        'oc-spinner': { template: '<span />' }
      },
      directives: {
        'oc-tooltip': {}
      }
    }
  })
}

function folderEntry() {
  return {
    id: 'dir-entry',
    path: 'dir',
    name: 'dir',
    parent: '/',
    isDir: true,
    size: 0,
    previewKind: 'directory'
  }
}

function textEntry() {
  return {
    id: 'file-entry',
    path: 'dir/file.txt',
    name: 'file.txt',
    parent: 'dir',
    isDir: false,
    size: 18,
    modTime: '2026-02-03T15:04:05Z',
    createdTime: '2026-01-02T03:04:05Z',
    mimeType: 'text/plain',
    previewKind: 'text'
  }
}

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function textResponse(value: string) {
  return new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  })
}

function routeFetch(
  url: string,
  init: RequestInit = {},
  { rootEntries }: { rootEntries: unknown[] }
) {
  if (url === '/archive/healthz') {
    return jsonResponse({ status: 'ok' }, 200)
  }
  if (url === '/archive/api/previews') {
    return jsonResponse({ id: 'preview-1', format: 'zip' }, 201)
  }
  if (url === '/archive/api/previews/preview-1/entries?path=%2F') {
    return jsonResponse({ entries: rootEntries }, 200)
  }
  if (url === '/archive/api/previews/preview-1/entries?path=dir') {
    return jsonResponse({ entries: [textEntry()] }, 200)
  }
  if (url === '/archive/api/previews/preview-1/entries/file-entry/content') {
    return textResponse('hello from archive')
  }
  if (url === '/archive/api/previews/preview-1/entries/file-entry/download' && init.method === 'POST') {
    return jsonResponse({
      downloadUrl:
        '/archive/api/previews/preview-1/entries/file-entry/content?download=1&token=token-1'
    }, 201)
  }
  if (url === '/archive/api/extractions' && init.method === 'POST') {
    return jsonResponse({ id: 'job-1', status: 'queued' }, 202)
  }
  if (url === '/archive/api/previews/preview-1' && init.method === 'DELETE') {
    return jsonResponse({}, 200)
  }
  return jsonResponse({ error: `unexpected ${url}` }, 500)
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text().includes(text))
  expect(button, `button containing ${text}`).toBeTruthy()
  return button!
}
