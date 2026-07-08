import { unref } from 'vue'
import { useExtensions } from '../../../src/composables/useExtensions'

const embedModeEnabled = vi.hoisted(() => ({ __v_isRef: true, value: false }))
const inspectExtensionPoints = vi.hoisted(() => ({ value: true }))
const extensionPoints = vi.hoisted(() => ({
  value: [{ id: 'app.runtime.snackbars' }, { id: 'app.runtime.header.right' }]
}))

vi.mock('@opencloud-eu/web-pkg', () => ({
  useEmbedMode: () => ({ isEnabled: embedModeEnabled }),
  useExtensionRegistry: () =>
    inspectExtensionPoints.value
      ? {
          getExtensionPoints: () => extensionPoints.value
        }
      : {}
}))

vi.mock('../../../src/composables/useUnzipAction', () => ({
  useUnzipAction: () => ({ name: 'extract' })
}))

vi.mock('../../../src/composables/useZipAction', () => ({
  useCreateArchiveActions: () => [{ name: 'create-zip' }, { name: 'create-tar-gzip' }],
  useDownloadArchiveActions: () => [{ name: 'download-zip' }, { name: 'download-tar-gzip' }]
}))

describe('useExtensions', () => {
  beforeEach(() => {
    embedModeEnabled.value = false
    inspectExtensionPoints.value = true
    extensionPoints.value = [{ id: 'app.runtime.snackbars' }, { id: 'app.runtime.header.right' }]
  })

  it('registers flat archive actions by default', () => {
    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.filter(({ type }) => type === 'action').map(({ id }) => id)).toEqual([
      'com.github.opencloud-eu.web-extensions.file-archiver.create-zip',
      'com.github.opencloud-eu.web-extensions.file-archiver.create-tar-gzip',
      'com.github.opencloud-eu.web-extensions.file-archiver.download-zip',
      'com.github.opencloud-eu.web-extensions.file-archiver.download-tar-gzip',
      'com.github.opencloud-eu.web-extensions.file-archiver.extract'
    ])
  })

  it('registers archive task panel when the snackbar extension point exists', () => {
    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.task-panel'
    )
  })

  it('registers floating task panel when snackbar extension point is missing', () => {
    extensionPoints.value = [{ id: 'app.runtime.header.right' }]

    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.floating-task-panel'
    )
    expect(extensions.map(({ id }) => id)).not.toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.task-panel'
    )
  })

  it('registers floating task panel when extension points can not be inspected', () => {
    inspectExtensionPoints.value = false

    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.floating-task-panel'
    )
  })

  it('does not register archive task panel in embed mode', () => {
    embedModeEnabled.value = true

    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).not.toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.task-panel'
    )
    expect(extensions.map(({ id }) => id)).not.toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.floating-task-panel'
    )
  })
})
