import { computed, ref, unref } from 'vue'
import { ArchiveServiceConfig, useArchiveService } from './useArchiveService'

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

type ArchiveConfig = ArchiveServiceConfig & {
  archivePollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2000

const jobs = ref<ArchiveJob[]>([])
const dismissed = ref(new Set<string>())
const loading = ref(false)
let pollTimer: number | undefined

function getPollIntervalMs(applicationConfig: ArchiveConfig = {}) {
  return Number(applicationConfig.archivePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
}

export function useArchiveJobs(applicationConfig: ArchiveConfig = {}) {
  const { requestJson } = useArchiveService(applicationConfig)

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
    void refreshJobs().catch((): void => undefined)
    pollTimer = window.setInterval((): void => {
      void refreshJobs().catch((): void => undefined)
    }, getPollIntervalMs(applicationConfig))
  }

  async function cancelJob(job: ArchiveJob) {
    await requestJson(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
    await refreshJobs()
  }

  async function dismissJob(job: ArchiveJob) {
    await requestJson(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
    dismissed.value = new Set([...unref(dismissed), job.id])
    await refreshJobs()
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
