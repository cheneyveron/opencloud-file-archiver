<template>
  <teleport to="body">
    <div
      class="archive-floating-task-panel"
      :style="{ '--archive-floating-bottom': `${bottomOffset}px` }"
    >
      <div class="archive-floating-task-panel__content">
        <archive-task-panel :application-config="applicationConfig" />
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { AppConfigObject } from '@opencloud-eu/web-pkg'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ArchiveTaskPanel from './ArchiveTaskPanel.vue'

defineProps<{
  applicationConfig?: AppConfigObject
}>()

const DEFAULT_BOTTOM_OFFSET = 20
const SNACKBAR_GAP = 12

const bottomOffset = ref(DEFAULT_BOTTOM_OFFSET)
let animationFrame = 0
let resizeObserver: ResizeObserver | undefined
let mutationObserver: MutationObserver | undefined

function updateBottomOffset() {
  const snackbars = document.querySelector<HTMLElement>('.snackbars')

  if (!snackbars) {
    bottomOffset.value = DEFAULT_BOTTOM_OFFSET
    return
  }

  const rect = snackbars.getBoundingClientRect()
  const distanceFromBottom = Math.max(0, window.innerHeight - rect.bottom)

  bottomOffset.value =
    rect.height > 1
      ? Math.ceil(distanceFromBottom + rect.height + SNACKBAR_GAP)
      : DEFAULT_BOTTOM_OFFSET
}

function scheduleBottomOffsetUpdate() {
  window.cancelAnimationFrame(animationFrame)
  animationFrame = window.requestAnimationFrame(updateBottomOffset)
}

onMounted(() => {
  nextTick(() => {
    const snackbars = document.querySelector<HTMLElement>('.snackbars')

    updateBottomOffset()
    window.addEventListener('resize', scheduleBottomOffsetUpdate)

    if (!snackbars) {
      return
    }

    resizeObserver = new ResizeObserver(scheduleBottomOffsetUpdate)
    resizeObserver.observe(snackbars)

    mutationObserver = new MutationObserver(scheduleBottomOffsetUpdate)
    mutationObserver.observe(snackbars, {
      attributes: true,
      childList: true,
      subtree: true
    })
  })
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(animationFrame)
  window.removeEventListener('resize', scheduleBottomOffsetUpdate)
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
})
</script>

<style scoped>
.archive-floating-task-panel {
  position: fixed;
  right: 1rem;
  bottom: var(--archive-floating-bottom, 1.25rem);
  left: 1rem;
  z-index: calc(var(--z-index-modal, 1000) + 1);
  max-width: 32rem;
  pointer-events: none;
}

.archive-floating-task-panel__content {
  pointer-events: auto;
}

@media (min-width: 640px) {
  .archive-floating-task-panel {
    right: 1.25rem;
    left: auto;
    width: min(28rem, calc(100vw - 2.5rem));
  }
}
</style>
