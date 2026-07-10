<template>
  <div class="archive-viewer size-full flex flex-col overflow-hidden bg-role-surface">
    <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
      <div class="flex min-w-0 items-center gap-1">
        <oc-button appearance="raw" @click="openPath('/')">
          <oc-icon name="inbox-archive" fill-type="line" />
          <span class="truncate" v-text="resource.name" />
        </oc-button>
        <template v-for="segment in breadcrumbSegments" :key="segment.path">
          <oc-icon name="arrow-right-s" fill-type="line" size="small" />
          <oc-button appearance="raw" @click="openPath(segment.path)">
            <span class="truncate" v-text="segment.name" />
          </oc-button>
        </template>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <oc-button
          v-oc-tooltip="$gettext('Refresh')"
          appearance="raw"
          :aria-label="$gettext('Refresh')"
          @click="reloadPreview"
        >
          <oc-icon name="refresh" fill-type="line" />
        </oc-button>
        <oc-button
          :disabled="!selectedPaths.length || extracting"
          appearance="filled"
          @click="extractSelected"
        >
          <oc-icon name="inbox-unarchive" fill-type="line" />
          <span v-text="$gettext('Extract selected...')" />
        </oc-button>
      </div>
    </div>

    <div v-if="loading" class="flex size-full items-center justify-center">
      <oc-spinner :aria-label="$gettext('Loading archive')" size="xlarge" />
    </div>
    <div v-else-if="error" class="flex size-full flex-col items-center justify-center gap-3 px-6">
      <oc-icon name="file-damage" size="xlarge" color="var(--oc-role-error)" />
      <p class="max-w-xl text-center text-role-error" v-text="error" />
      <oc-button appearance="filled" @click="reloadPreview">
        <oc-icon name="refresh" fill-type="line" />
        <span v-text="$gettext('Retry')" />
      </oc-button>
    </div>
    <div v-else class="archive-viewer__content min-h-0 flex-1">
      <section class="min-h-0 overflow-auto border-r">
        <div class="archive-viewer__list">
          <div
            class="archive-viewer__row archive-viewer__row--header sticky top-0 z-1 border-b bg-role-surface-container px-3 py-2 text-sm font-semibold"
          >
            <span v-text="$gettext('Name')" />
            <span class="text-right" v-text="$gettext('Size')" />
            <span v-text="$gettext('Modified')" />
            <span class="text-center" v-text="$gettext('Actions')" />
            <input
              class="archive-viewer__checkbox justify-self-center"
              type="checkbox"
              :aria-label="$gettext('Select all')"
              :checked="entries.length > 0 && entries.every((entry) => selected.has(entry.path))"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
          </div>
          <ul class="oc-list">
            <li
              v-for="entry in entries"
              :key="entry.id"
              class="archive-viewer__row border-b px-3 py-2 hover:bg-role-surface-container"
              :class="{ 'bg-role-secondary-container': activeEntry?.id === entry.id }"
            >
              <oc-button
                class="min-w-0 justify-start"
                appearance="raw"
                no-hover
                @click="openEntry(entry)"
              >
                <oc-icon :name="entryIcon(entry)" fill-type="line" class="mr-2 shrink-0" />
                <span class="truncate" v-text="entry.name" />
              </oc-button>
              <span class="text-right text-sm text-role-on-surface-variant" v-text="entry.isDir ? '-' : formatSize(entry.size)" />
              <span class="truncate text-sm text-role-on-surface-variant" v-text="formatDateTime(entry.modTime)" />
              <div class="archive-viewer__actions justify-self-center">
                <oc-button
                  :id="entryActionToggleId(entry)"
                  v-oc-tooltip="$gettext('More actions')"
                  appearance="raw"
                  class="p-1"
                  :aria-label="$gettext('Actions for %{name}', { name: entry.name })"
                >
                  <oc-icon name="more-2" fill-type="line" />
                </oc-button>
                <oc-drop
                  :drop-id="entryActionDropId(entry)"
                  :toggle="`#${entryActionToggleId(entry)}`"
                  :title="$gettext('Actions')"
                  position="left-start"
                  padding-size="small"
                  close-on-click
                  enforce-drop-on-mobile
                >
                  <oc-list>
                    <li>
                      <oc-button
                        appearance="raw"
                        class="archive-viewer__action-item"
                        @click="extractEntryTo(entry)"
                      >
                        <oc-icon name="inbox-unarchive" fill-type="line" />
                        <span v-text="$gettext('Extract To...')" />
                      </oc-button>
                    </li>
                    <li v-if="!entry.isDir">
                      <oc-button
                        appearance="raw"
                        class="archive-viewer__action-item"
                        :disabled="downloadingEntryId === entry.id"
                        @click="downloadEntry(entry)"
                      >
                        <oc-icon name="download" fill-type="line" />
                        <span v-text="$gettext('Download')" />
                      </oc-button>
                    </li>
                  </oc-list>
                </oc-drop>
              </div>
              <input
                class="archive-viewer__checkbox justify-self-center self-center"
                type="checkbox"
                :aria-label="$gettext('Select %{name}', { name: entry.name })"
                :checked="selected.has(entry.path)"
                @click.stop
                @change="toggleEntry(entry, ($event.target as HTMLInputElement).checked)"
              />
            </li>
          </ul>
        </div>
      </section>

      <section class="min-h-0 overflow-auto">
        <div v-if="!activeEntry" class="flex size-full items-center justify-center px-6 text-role-on-surface-variant">
          <span v-text="$gettext('Select a file to preview')" />
        </div>
        <div v-else-if="previewLoading" class="flex size-full items-center justify-center">
          <oc-spinner :aria-label="$gettext('Loading preview')" size="large" />
        </div>
        <div v-else-if="previewError" class="flex size-full flex-col items-center justify-center gap-3 px-6">
          <oc-icon name="file-damage" size="xlarge" color="var(--oc-role-error)" />
          <p class="max-w-xl text-center text-role-error" v-text="previewError" />
        </div>
        <pre
          v-else-if="activeEntry.previewKind === 'text'"
          class="m-0 min-h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-sm"
          v-text="previewText"
        />
        <div v-else-if="activeEntry.previewKind === 'image'" class="flex size-full items-center justify-center p-4">
          <img :src="previewUrl" :alt="activeEntry.name" class="max-h-full max-w-full object-contain" />
        </div>
        <object
          v-else-if="activeEntry.previewKind === 'pdf'"
          class="size-full"
          :data="previewUrl"
          type="application/pdf"
        />
        <div v-else class="flex size-full flex-col items-center justify-center gap-3 px-6 text-role-on-surface-variant">
          <oc-icon name="file" size="xlarge" />
          <p class="max-w-xl text-center" v-text="unsupportedPreviewMessage" />
          <oc-button appearance="filled" @click="selectAndExtract(activeEntry)">
            <oc-icon name="inbox-unarchive" fill-type="line" />
            <span v-text="$gettext('Extract this file...')" />
          </oc-button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  LocationPickerModal,
  useFolderLink,
  useGetMatchingSpace,
  useMessages,
  useModals
} from '@opencloud-eu/web-pkg'
import { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { computed, markRaw, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'
import { useAskForArchivePassword } from '../composables/useAskForArchivePassword'
import { ArchiveServiceConfig, useArchiveService } from '../composables/useArchiveService'

type ArchiveEntry = {
  id: string
  path: string
  name: string
  parent: string
  isDir: boolean
  size?: number
  modTime?: string
  createdTime?: string
  mimeType?: string
  previewKind?: 'directory' | 'text' | 'image' | 'pdf' | 'office' | 'unsupported'
}

type ArchivePreview = {
  id: string
  format: string
  entries?: ArchiveEntry[]
}

type ArchiveConfig = ArchiveServiceConfig

const props = defineProps<{
  applicationConfig?: ArchiveConfig
  resource: Resource
  space: SpaceResource
}>()

const { $gettext } = useGettext()
const archiveService = useArchiveService(props.applicationConfig || {})
const { askForArchivePassword } = useAskForArchivePassword()
const { showErrorMessage, showMessage } = useMessages()
const { dispatchModal } = useModals()
const { getParentFolderLink } = useFolderLink()
const { getMatchingSpace } = useGetMatchingSpace()

const loading = ref(false)
const extracting = ref(false)
const previewLoading = ref(false)
const error = ref('')
const previewError = ref('')
const preview = ref<ArchivePreview>()
const currentPath = ref('/')
const entries = ref<ArchiveEntry[]>([])
const selected = ref(new Set<string>())
const password = ref('')
const activeEntry = ref<ArchiveEntry>()
const previewText = ref('')
const previewUrl = ref('')
const downloadingEntryId = ref('')

const selectedPaths = computed(() => [...unref(selected)])

const breadcrumbSegments = computed(() => {
  if (unref(currentPath) === '/') {
    return []
  }
  const parts = unref(currentPath).split('/').filter(Boolean)
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/')
  }))
})

const unsupportedPreviewMessage = computed(() => {
  if (unref(activeEntry)?.previewKind === 'office') {
    return $gettext('Office files can be extracted and opened from a normal folder.')
  }
  return $gettext('Preview is not available for this file.')
})

function getResourceName(resource: Resource) {
  return resource.name || resource.path.split('/').filter(Boolean).pop() || 'archive'
}

const requestJson = archiveService.requestJson

async function createPreview(inputPassword = '') {
  return requestJson<ArchivePreview>('/api/previews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: {
        spaceId: props.space.id,
        path: props.resource.path,
        name: getResourceName(props.resource),
        mimeType: props.resource.mimeType,
        size: Number(props.resource.size || 0)
      },
      ...(inputPassword && { password: inputPassword })
    })
  })
}

async function loadEntries(path = unref(currentPath)) {
  if (!unref(preview)) {
    return
  }
  const payload = await requestJson<{ entries: ArchiveEntry[] }>(
    `/api/previews/${encodeURIComponent(unref(preview).id)}/entries?path=${encodeURIComponent(path)}`
  )
  entries.value = payload.entries || []
  currentPath.value = path
}

async function reloadPreview() {
  loading.value = true
  error.value = ''
  activeEntry.value = undefined
  clearPreviewContent()
  selected.value = new Set()
  try {
    try {
      preview.value = await createPreview(unref(password))
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code !== 'PASSWORD_REQUIRED' || unref(password)) {
        throw e
      }
      const value = await askForArchivePassword()
      if (!value) {
        throw e
      }
      password.value = value
      preview.value = await createPreview(value)
    }
    await loadEntries('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function openPath(path: string) {
  void loadEntries(path).catch((e) => {
    error.value = e instanceof Error ? e.message : String(e)
  })
}

function openEntry(entry: ArchiveEntry) {
  if (entry.isDir) {
    openPath(entry.path)
    return
  }
  activeEntry.value = entry
}

async function loadPreviewContent(entry: ArchiveEntry) {
  clearPreviewContent()
  previewError.value = ''
  if (!unref(preview) || entry.isDir) {
    return
  }
  if (!['text', 'image', 'pdf'].includes(entry.previewKind || '')) {
    return
  }
  previewLoading.value = true
  try {
    const response = await archiveService.request(
      `/api/previews/${encodeURIComponent(unref(preview).id)}/entries/${encodeURIComponent(entry.id)}/content`,
      { headers: { Accept: '*/*' } }
    )
    if (entry.previewKind === 'text') {
      previewText.value = await response.text()
      return
    }
    const blob = await response.blob()
    previewUrl.value = URL.createObjectURL(blob)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

function clearPreviewContent() {
  previewText.value = ''
  previewError.value = ''
  if (unref(previewUrl)) {
    URL.revokeObjectURL(unref(previewUrl))
  }
  previewUrl.value = ''
}

function toggleEntry(entry: ArchiveEntry, checked: boolean) {
  const next = new Set(unref(selected))
  if (checked) {
    next.add(entry.path)
  } else {
    next.delete(entry.path)
  }
  selected.value = next
}

function toggleAll(checked: boolean) {
  const next = new Set(unref(selected))
  for (const entry of unref(entries)) {
    if (checked) {
      next.add(entry.path)
    } else {
      next.delete(entry.path)
    }
  }
  selected.value = next
}

function selectAndExtract(entry: ArchiveEntry) {
  void extractEntryTo(entry)
}

async function extractSelected() {
  if (!unref(selectedPaths).length) {
    return
  }
  openExtractionPicker(unref(selectedPaths), $gettext('Extract selected files to'))
}

function extractEntryTo(entry: ArchiveEntry) {
  openExtractionPicker(
    [entry.path],
    entry.isDir ? $gettext('Extract folder to') : $gettext('Extract file to')
  )
}

function openExtractionPicker(includePaths: string[], title: string) {
  if (!includePaths.length) {
    return
  }
  dispatchModal({
    elementClass: 'location-picker-modal file-archiver-location-picker-modal',
    title,
    customComponent: markRaw(LocationPickerModal),
    hideActions: true,
    customComponentAttrs: () => ({
      submitButtonTitle: $gettext('Extract here'),
      parentFolderLink: getParentFolderLink(props.resource),
      callbackFn: (targetResources: Resource[]) => {
        const targetFolder = targetResources[0]
        void createPartialExtraction(targetFolder, includePaths)
      }
    }),
    focusTrapInitial: false
  })
}

async function createPartialExtraction(targetFolder: Resource, includePaths: string[]) {
  extracting.value = true
  try {
    const targetSpace = getMatchingSpace(targetFolder)
    await requestJson('/api/extractions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: {
          spaceId: props.space.id,
          path: props.resource.path,
          name: getResourceName(props.resource),
          mimeType: props.resource.mimeType,
          size: Number(props.resource.size || 0)
        },
        destination: {
          spaceId: targetSpace.id,
          path: targetFolder.path
        },
        includePaths,
        ...(unref(password) && { password: unref(password) }),
        conflicts: 'keep-both'
      })
    })
    showMessage({ title: $gettext('Archive extraction started'), status: 'passive' })
  } catch (e) {
    showErrorMessage({ title: $gettext('Failed to extract archive'), errors: [e] })
  } finally {
    extracting.value = false
  }
}

async function downloadEntry(entry: ArchiveEntry) {
  if (!unref(preview) || entry.isDir) {
    return
  }
  downloadingEntryId.value = entry.id
  try {
    const payload = await requestJson<{ downloadUrl: string }>(
      `/api/previews/${encodeURIComponent(unref(preview).id)}/entries/${encodeURIComponent(entry.id)}/download`,
      { method: 'POST' }
    )
    openDownloadUrl(resolveServiceUrl(payload.downloadUrl))
  } catch (e) {
    showErrorMessage({ title: $gettext('Failed to download archive entry'), errors: [e] })
  } finally {
    downloadingEntryId.value = ''
  }
}

function openDownloadUrl(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.target = '_self'
  link.click()
}

function resolveServiceUrl(value: string) {
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  const serviceRelativePath = value.startsWith('/archive/')
    ? value.slice('/archive'.length)
    : value
  return `${archiveService.serviceUrl}${serviceRelativePath}`
}

function entryActionToggleId(entry: ArchiveEntry) {
  return `archive-entry-actions-${entry.id}`
}

function entryActionDropId(entry: ArchiveEntry) {
  return `archive-entry-actions-drop-${entry.id}`
}

function entryIcon(entry: ArchiveEntry) {
  if (entry.isDir) {
    return 'folder'
  }
  switch (entry.previewKind) {
    case 'image':
      return 'image'
    case 'pdf':
      return 'file-pdf'
    case 'text':
      return 'file-text'
    default:
      return 'file'
  }
}

function formatSize(size?: number) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return '-'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) {
    return '-'
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

watch(activeEntry, (entry) => {
  if (!entry) {
    clearPreviewContent()
    return
  }
  void loadPreviewContent(entry)
})

onMounted(() => {
  void reloadPreview()
})

onBeforeUnmount(() => {
  clearPreviewContent()
  if (unref(preview)) {
    void requestJson(`/api/previews/${encodeURIComponent(unref(preview).id)}`, {
      method: 'DELETE'
    }).catch((): void => undefined)
  }
})
</script>

<style scoped>
.archive-viewer__content {
  display: grid;
  grid-template-columns: minmax(34rem, 46%) minmax(0, 1fr);
}

.archive-viewer__list {
  min-width: 38rem;
}

.archive-viewer__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5rem 8.75rem 4rem 3rem;
  align-items: center;
  column-gap: 0.5rem;
  min-height: 2.75rem;
}

.archive-viewer__row--header {
  min-height: 2.25rem;
}

.archive-viewer__actions {
  min-width: 4rem;
}

.archive-viewer__action-item {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  gap: 0.5rem;
}

.archive-viewer__checkbox {
  width: 1rem;
  min-width: 1rem;
  height: 1rem;
  margin: 0;
}

@media (max-width: 960px) {
  .archive-viewer__content {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
