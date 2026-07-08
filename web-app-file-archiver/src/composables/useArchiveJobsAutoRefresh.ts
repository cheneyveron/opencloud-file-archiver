import { eventBus } from '@opencloud-eu/web-pkg'
import { onMounted, ref, unref, watch } from 'vue'
import { ArchiveJob, useArchiveJobs } from './useArchiveJobs'

type ArchiveJobsConfig = Parameters<typeof useArchiveJobs>[0]

function shouldReloadFiles(job: ArchiveJob) {
  return job.status === 'succeeded' && job.output?.mode === 'save'
}

export function useArchiveJobsAutoRefresh(applicationConfig: ArchiveJobsConfig = {}) {
  const reloadedJobIds = ref(new Set<string>())
  const archiveJobs = useArchiveJobs(applicationConfig)

  onMounted(() => {
    archiveJobs.startPolling()
  })

  watch(
    archiveJobs.jobs,
    (value) => {
      for (const job of value) {
        if (!shouldReloadFiles(job)) {
          continue
        }
        if (unref(reloadedJobIds).has(job.id)) {
          continue
        }
        reloadedJobIds.value = new Set([...unref(reloadedJobIds), job.id])
        eventBus.publish('app.files.list.load')
      }
    },
    { deep: true }
  )

  return archiveJobs
}
