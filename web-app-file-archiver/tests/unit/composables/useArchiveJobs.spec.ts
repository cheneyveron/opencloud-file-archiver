import { unref } from 'vue'
import { useArchiveJobs } from '../../../src/composables/useArchiveJobs'
import type { ArchiveJob } from '../../../src/composables/useArchiveJobs'

vi.mock('@opencloud-eu/web-pkg', () => ({
  useRequestHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } })
}))

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({ $gettext: (value: string) => value })
}))

describe('archive jobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears completed jobs through the jobs API', async () => {
    const job: ArchiveJob = {
      id: 'job-1',
      type: 'extraction',
      status: 'succeeded',
      progress: {}
    }
    let serverJobs = [job]
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/archive/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      if (url === '/archive/api/jobs' && !init?.method) {
        return Promise.resolve(jsonResponse({ jobs: serverJobs }))
      }
      if (url === '/archive/api/jobs/job-1' && init?.method === 'DELETE') {
        serverJobs = []
        return Promise.resolve(jsonResponse(job))
      }
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { jobs, refreshJobs, dismissJob } = useArchiveJobs()
    await refreshJobs()

    expect(unref(jobs).map((item) => item.id)).toEqual(['job-1'])

    await dismissJob(unref(jobs)[0])

    expect(fetchMock).toHaveBeenCalledWith(
      '/archive/api/jobs/job-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          Accept: 'application/json'
        })
      })
    )
    expect(unref(jobs)).toEqual([])
  })

  it('reports a missing backend explicitly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    )

    const { refreshJobs } = useArchiveJobs()

    await expect(refreshJobs()).rejects.toThrow(
      'The File Archiver backend is not installed, is unreachable, or returned an incompatible response. Contact your administrator or follow the backend installation guide.'
    )
  })
})

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload)
  }
}
