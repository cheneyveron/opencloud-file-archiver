import { unref } from 'vue'
import { useExtensions } from '../../../src/composables/useExtensions'

const embedModeEnabled = vi.hoisted(() => ({ __v_isRef: true, value: false }))

vi.mock('@opencloud-eu/web-pkg', () => ({
  useEmbedMode: () => ({ isEnabled: embedModeEnabled })
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

  it('registers archive task panel outside embed mode', () => {
    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.task-panel'
    )
  })

  it('does not register archive task panel in embed mode', () => {
    embedModeEnabled.value = true

    const extensions = unref(useExtensions({ applicationConfig: {} } as never))

    expect(extensions.map(({ id }) => id)).not.toContain(
      'com.github.opencloud-eu.web-extensions.file-archiver.task-panel'
    )
  })
})
