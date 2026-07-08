import {
  ActionExtension,
  ApplicationSetupOptions,
  CustomComponentExtension,
  FileAction,
  useEmbedMode
} from '@opencloud-eu/web-pkg'
import { computed, markRaw, unref } from 'vue'
import ArchiveTaskPanel from '../components/ArchiveTaskPanel.vue'
import { useUnzipAction } from './useUnzipAction'
import { ArchiveConfig, useCreateArchiveActions, useDownloadArchiveActions } from './useZipAction'

const EXTENSION_ID_PREFIX = 'com.github.opencloud-eu.web-extensions.file-archiver'

function actionExtension(action: FileAction): ActionExtension {
  return {
    id: `${EXTENSION_ID_PREFIX}.${action.name}`,
    type: 'action',
    extensionPointIds: ['global.files.context-actions'],
    action
  }
}

export const useExtensions = ({ applicationConfig }: ApplicationSetupOptions) => {
  const archiveConfig = applicationConfig as ArchiveConfig
  const extractArchiveAction = useUnzipAction(applicationConfig)
  const createArchiveActions = useCreateArchiveActions(archiveConfig)
  const downloadArchiveActions = useDownloadArchiveActions(archiveConfig)
  const { isEnabled: isEmbedModeEnabled } = useEmbedMode()

  const archiveActionExtensions = computed<ActionExtension[]>(() => {
    return [
      ...unref(createArchiveActions),
      ...unref(downloadArchiveActions),
      unref(extractArchiveAction)
    ].map(actionExtension)
  })

  const taskPanelExtension = computed<CustomComponentExtension>(() => {
    return {
      id: `${EXTENSION_ID_PREFIX}.task-panel`,
      type: 'customComponent',
      extensionPointIds: ['app.runtime.snackbars'],
      content: markRaw(ArchiveTaskPanel),
      componentProps: () => ({ applicationConfig })
    }
  })

  return computed<(ActionExtension | CustomComponentExtension)[]>(() => {
    const extensions: (ActionExtension | CustomComponentExtension)[] = [
      ...unref(archiveActionExtensions)
    ]

    if (!unref(isEmbedModeEnabled)) {
      extensions.push(unref(taskPanelExtension))
    }

    return extensions
  })
}
