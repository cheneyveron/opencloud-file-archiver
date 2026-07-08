<template>
  <div
    v-if="jobs.length"
    id="archive-task-panel"
    class="rounded-xl shadow-sm/10 bg-role-surface mx-auto sm:m-0 w-full sm:w-md max-w-lg border mt-2"
  >
    <div class="flex justify-between items-center px-4 py-2 rounded-t-xl">
      <p class="my-1 font-bold" v-text="title" />
      <oc-button
        :aria-label="
          bodyCollapsed ? $gettext('Expand archive tasks') : $gettext('Collapse archive tasks')
        "
        appearance="raw"
        @click="bodyCollapsed = !bodyCollapsed"
      >
        <oc-icon :name="bodyCollapsed ? 'arrow-up-s' : 'arrow-down-s'" fill-type="line" />
      </oc-button>
    </div>
    <div v-if="!bodyCollapsed" class="px-4 pb-4">
      <ul class="oc-list">
        <li v-for="job in jobs" :key="job.id" class="py-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0">
                <oc-spinner v-if="isRunning(job)" size="small" />
                <oc-icon v-else-if="job.status === 'succeeded'" name="check" size="small" />
                <oc-icon
                  v-else-if="job.status === 'failed'"
                  name="close"
                  size="small"
                  color="var(--oc-role-error)"
                />
                <oc-icon v-else name="close" size="small" />
                <span class="truncate text-sm font-semibold" v-text="jobLabel(job)" />
              </div>
              <p
                v-if="job.progress?.currentEntry"
                class="truncate text-sm text-role-on-surface-variant my-1"
                v-text="job.progress.currentEntry"
              />
              <p
                v-else-if="job.error"
                class="truncate text-sm text-role-error my-1"
                v-text="job.error"
              />
              <oc-progress
                v-if="isRunning(job)"
                class="mt-2"
                :value="job.progress?.percent || 0"
                :max="100"
                size="small"
                :indeterminate="!job.progress?.percent"
              />
            </div>
            <div class="flex shrink-0">
              <oc-button
                v-if="isRunning(job)"
                v-oc-tooltip="$gettext('Cancel archive task')"
                appearance="raw"
                :aria-label="$gettext('Cancel archive task')"
                @click="cancelJob(job)"
              >
                <oc-icon name="close-circle" fill-type="line" />
              </oc-button>
              <oc-button
                v-else
                v-oc-tooltip="$gettext('Clear archive task')"
                appearance="raw"
                :aria-label="$gettext('Clear archive task')"
                @click="dismissJob(job)"
              >
                <oc-icon name="close" />
              </oc-button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, unref } from 'vue'
import { useGettext } from 'vue3-gettext'
import { AppConfigObject } from '@opencloud-eu/web-pkg'
import { ArchiveJob } from '../composables/useArchiveJobs'
import { useArchiveJobsAutoRefresh } from '../composables/useArchiveJobsAutoRefresh'

const props = defineProps<{
  applicationConfig?: AppConfigObject
}>()

const { $gettext } = useGettext()
const bodyCollapsed = ref(false)
const { jobs, cancelJob, dismissJob } = useArchiveJobsAutoRefresh(props.applicationConfig || {})

const title = computed(() => {
  const running = unref(jobs).filter(isRunning).length
  if (running) {
    return $gettext('Archive tasks (%{count})', { count: running.toString() })
  }
  return $gettext('Archive tasks')
})

function isRunning(job: ArchiveJob) {
  return job.status === 'queued' || job.status === 'running'
}

function jobLabel(job: ArchiveJob) {
  if (job.type === 'compression') {
    if (job.status === 'succeeded') {
      return $gettext('Archive created')
    }
    if (job.status === 'failed') {
      return $gettext('Archive creation failed')
    }
    return $gettext('Creating archive')
  }
  if (job.status === 'succeeded') {
    return $gettext('Archive extracted')
  }
  if (job.status === 'failed') {
    return $gettext('Archive extraction failed')
  }
  return $gettext('Extracting archive')
}
</script>
