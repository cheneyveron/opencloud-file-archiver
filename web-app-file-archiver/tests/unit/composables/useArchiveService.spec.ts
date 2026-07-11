import { useArchiveService } from '../../../src/composables/useArchiveService'

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({
    $gettext: (value: string) => `translated: ${value}`
  })
}))

vi.mock('@opencloud-eu/web-pkg', () => ({
  useRequestHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } })
}))

describe('archive service', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('probes the configured backend once and reuses the healthy result', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === 'https://archive.example.test/service/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      return Promise.resolve(jsonResponse({ value: url }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = useArchiveService({
      fileArchiverServiceUrl: 'https://archive.example.test/service/'
    })
    const second = useArchiveService({
      fileArchiverServiceUrl: 'https://archive.example.test/service/'
    })

    await expect(first.requestJson('/api/first')).resolves.toEqual({
      value: 'https://archive.example.test/service/api/first'
    })
    await expect(second.requestJson('/api/second')).resolves.toEqual({
      value: 'https://archive.example.test/service/api/second'
    })

    expect(fetchMock).toHaveBeenCalledWith('https://archive.example.test/service/healthz', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    })
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/healthz'))
    ).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://archive.example.test/service/api/first',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          Accept: 'application/json'
        })
      })
    )
  })

  it('probes the default service URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/archive/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      return Promise.resolve(jsonResponse({ jobs: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await useArchiveService().requestJson('/api/jobs')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/archive/healthz',
      '/archive/api/jobs'
    ])
  })

  it.each([
    ['an unreachable backend', () => Promise.reject(new TypeError('network failed'))],
    ['a missing backend', () => Promise.resolve(jsonResponse({ error: 'not found' }, 404))],
    [
      'a non-JSON health response',
      () => Promise.resolve(new Response('<html>OpenCloud</html>', { status: 200 }))
    ],
    [
      'an incompatible health response',
      () => Promise.resolve(jsonResponse({ status: 'starting' }))
    ]
  ])('reports %s with installation guidance', async (_name, healthResponse) => {
    const fetchMock = vi.fn(healthResponse)
    vi.stubGlobal('fetch', fetchMock)

    await expect(useArchiveService().requestJson('/api/jobs')).rejects.toMatchObject({
      code: 'ARCHIVE_BACKEND_UNAVAILABLE',
      message: expect.stringContaining(
        'translated: The File Archiver backend is not installed, is unreachable, or returned an incompatible response.'
      )
    })
    await expect(useArchiveService().requestJson('/api/jobs')).rejects.toThrow(
      'Contact your administrator or follow the backend installation guide:'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a successful non-JSON API response as an incompatible backend', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(new Response('<html>OpenCloud</html>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(useArchiveService().requestJson('/api/jobs')).rejects.toMatchObject({
      code: 'ARCHIVE_BACKEND_UNAVAILABLE',
      message: expect.stringContaining('returned an incompatible response')
    })
  })

  it('accepts a 204 response without poisoning the backend health cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const service = useArchiveService()
    await expect(
      service.requestJson('/api/previews/preview-1', { method: 'DELETE' })
    ).resolves.toBeUndefined()
    await expect(service.requestJson('/api/jobs')).resolves.toEqual({ jobs: [] })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/archive/healthz',
      '/archive/api/previews/preview-1',
      '/archive/api/jobs'
    ])
  })

  it('preserves structured backend errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'unsupported archive', code: 'UNSUPPORTED_ARCHIVE' }, 400)
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(useArchiveService().requestJson('/api/extractions')).rejects.toMatchObject({
      code: 'UNSUPPORTED_ARCHIVE',
      message: 'unsupported archive',
      status: 400
    })
  })
})

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
