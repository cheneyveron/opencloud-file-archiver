<template>
  <div
    class="fixed inset-x-4 bottom-5 z-[calc(var(--z-index-modal)+1)] pointer-events-none sm:inset-x-auto sm:right-5 sm:w-md max-w-lg"
  >
    <div class="pointer-events-auto">
      <archive-task-panel :application-config="applicationConfig" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { AppConfigObject } from '@opencloud-eu/web-pkg'
import ArchiveTaskPanel from './ArchiveTaskPanel.vue'

defineProps<{
  applicationConfig?: AppConfigObject
}>()
</script>
