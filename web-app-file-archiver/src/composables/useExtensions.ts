import {
  ActionExtension,
  ApplicationSetupOptions,
  CustomComponentExtension,
  FileAction,
  useEmbedMode,
  useExtensionRegistry
} from '@opencloud-eu/web-pkg'
import { computed, markRaw, unref } from 'vue'
import ArchiveFloatingTaskPanel from '../components/ArchiveFloatingTaskPanel.vue'
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
  const extensionRegistry = useExtensionRegistry()

  function canInspectExtensionPoints() {
    return typeof extensionRegistry.getExtensionPoints === 'function'
  }

  function hasExtensionPoint(id: string) {
    if (!canInspectExtensionPoints()) {
      return false
    }
    return extensionRegistry.getExtensionPoints().some((extensionPoint) => extensionPoint.id === id)
  }

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

  const floatingTaskPanelExtension = computed<CustomComponentExtension>(() => {
    return {
      id: `${EXTENSION_ID_PREFIX}.floating-task-panel`,
      type: 'customComponent',
      extensionPointIds: ['app.runtime.header.right'],
      content: markRaw(ArchiveFloatingTaskPanel),
      componentProps: () => ({ applicationConfig })
    }
  })

  return computed<(ActionExtension | CustomComponentExtension)[]>(() => {
    const extensions: (ActionExtension | CustomComponentExtension)[] = [
      ...unref(archiveActionExtensions)
    ]

    if (!unref(isEmbedModeEnabled)) {
      if (hasExtensionPoint('app.runtime.snackbars')) {
        extensions.push(unref(taskPanelExtension))
      } else if (!canInspectExtensionPoints() || hasExtensionPoint('app.runtime.header.right')) {
        extensions.push(unref(floatingTaskPanelExtension))
      }
    }

    return extensions
  })
}
