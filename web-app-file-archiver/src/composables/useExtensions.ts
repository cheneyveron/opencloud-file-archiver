import {
  ActionExtension,
  ApplicationSetupOptions,
  CustomComponentExtension,
  useEmbedMode,
} from "@opencloud-eu/web-pkg";
import { computed, markRaw, unref } from "vue";
import ArchiveTaskPanel from "../components/ArchiveTaskPanel.vue";
import { useUnzipAction } from "./useUnzipAction";
import {
  useCreateArchiveAction,
  useDownloadArchiveAction,
} from "./useZipAction";

export const useExtensions = ({
  applicationConfig,
}: ApplicationSetupOptions) => {
  const extractArchiveAction = useUnzipAction(applicationConfig);
  const createArchiveAction = useCreateArchiveAction(applicationConfig);
  const downloadArchiveAction = useDownloadArchiveAction(applicationConfig);
  const { isEnabled: isEmbedModeEnabled } = useEmbedMode();

  const extractArchiveActionExtension = computed<ActionExtension>(() => {
    return {
      id: "com.github.opencloud-eu.web-extensions.file-archiver.extract",
      type: "action",
      extensionPointIds: ["global.files.context-actions"],
      action: unref(extractArchiveAction),
    };
  });

  const createArchiveActionExtension = computed<ActionExtension>(() => {
    return {
      id: "com.github.opencloud-eu.web-extensions.file-archiver.create",
      type: "action",
      extensionPointIds: ["global.files.context-actions"],
      action: unref(createArchiveAction),
    };
  });

  const downloadArchiveActionExtension = computed<ActionExtension>(() => {
    return {
      id: "com.github.opencloud-eu.web-extensions.file-archiver.download",
      type: "action",
      extensionPointIds: ["global.files.context-actions"],
      action: unref(downloadArchiveAction),
    };
  });

  const taskPanelExtension = computed<CustomComponentExtension>(() => {
    return {
      id: "com.github.opencloud-eu.web-extensions.file-archiver.task-panel",
      type: "customComponent",
      extensionPointIds: ["app.runtime.snackbars"],
      content: markRaw(ArchiveTaskPanel),
      componentProps: () => ({ applicationConfig }),
    };
  });

  return computed<(ActionExtension | CustomComponentExtension)[]>(() => {
    const extensions: (ActionExtension | CustomComponentExtension)[] = [
      unref(createArchiveActionExtension),
      unref(downloadArchiveActionExtension),
      unref(extractArchiveActionExtension),
    ];

    if (!unref(isEmbedModeEnabled)) {
      extensions.push(unref(taskPanelExtension));
    }

    return extensions;
  });
};
