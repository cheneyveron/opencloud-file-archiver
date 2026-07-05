import { AppConfigObject, useRequestHeaders } from '@opencloud-eu/web-pkg'
import { computed, ref, unref } from 'vue'

export type ArchiveJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type ArchiveJob = {
  id: string
  type: 'compression' | 'extraction'
  status: ArchiveJobStatus
  stage?: string
  format?: string
  code?: string
  error?: string
  progress: {
    percent?: number
    bytesDone?: number
    bytesTotal?: number
    entriesDone?: number
    entriesTotal?: number
    currentEntry?: string
    speedBytesPerSecond?: number
  }
  output?: {
    mode?: string
    resourcePath?: string
    downloadUrl?: string
  }
}

type ArchiveConfig = AppConfigObject & {
  fileArchiverServiceUrl?: string
  archiveServiceUrl?: string
  unarchiveServiceUrl?: string
  archivePollIntervalMs?: number
}

const DEFAULT_SERVICE_URL = '/archive'
const DEFAULT_POLL_INTERVAL_MS = 2000

const jobs = ref<ArchiveJob[]>([])
const dismissed = ref(new Set<string>())
const loading = ref(false)
let pollTimer: number | undefined

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function getServiceUrl(applicationConfig: ArchiveConfig = {}) {
  return trimTrailingSlash(
    applicationConfig.fileArchiverServiceUrl ||
      applicationConfig.archiveServiceUrl ||
      applicationConfig.unarchiveServiceUrl ||
      DEFAULT_SERVICE_URL
  )
}

function getPollIntervalMs(applicationConfig: ArchiveConfig = {}) {
  return Number(applicationConfig.archivePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
}

export function useArchiveJobs(applicationConfig: ArchiveConfig = {}) {
  const requestHeaders = useRequestHeaders()
  const serviceUrl = computed(() => getServiceUrl(applicationConfig))

  async function requestJson<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(`${unref(serviceUrl)}${path}`, {
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
          : 'Archive request failed'
      throw new Error(message)
    }
    return payload as T
  }

  async function refreshJobs() {
    if (unref(loading)) {
      return
    }
    loading.value = true
    try {
      const payload = await requestJson<{ jobs: ArchiveJob[] }>('/api/jobs')
      jobs.value = payload.jobs || []
    } finally {
      loading.value = false
    }
  }

  function startPolling() {
    if (pollTimer) {
      return
    }
    void refreshJobs()
    pollTimer = window.setInterval((): void => {
      void refreshJobs().catch((): void => undefined)
    }, getPollIntervalMs(applicationConfig))
  }

  async function cancelJob(job: ArchiveJob) {
    await requestJson(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
    await refreshJobs()
  }

  function dismissJob(job: ArchiveJob) {
    dismissed.value = new Set([...unref(dismissed), job.id])
  }

  const visibleJobs = computed(() => {
    return unref(jobs).filter((job) => {
      if (job.status === 'queued' || job.status === 'running') {
        return true
      }
      return !unref(dismissed).has(job.id)
    })
  })

  return {
    jobs: visibleJobs,
    refreshJobs,
    startPolling,
    cancelJob,
    dismissJob
  }
}
