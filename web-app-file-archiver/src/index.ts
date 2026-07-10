import { useGettext } from "vue3-gettext";
import translations from "../l10n/translations.json";
import { AppWrapperRoute, defineWebApplication } from "@opencloud-eu/web-pkg";
import ArchiveViewer from "./components/ArchiveViewer.vue";
import { useExtensions } from "./composables/useExtensions";
import "./styles.css";

export default defineWebApplication({
  setup(options) {
    const { $gettext } = useGettext();
    const extensions = useExtensions(options);
    const appId = "file-archiver";
    const routeName = "file-archiver-preview";

    return {
      appInfo: {
        name: $gettext("File Archiver"),
        id: appId,
        icon: "inbox-archive",
        extensions: [
          { extension: "zip", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { extension: "7z", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { extension: "rar", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { extension: "tar", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { extension: "tgz", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { extension: "gz", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/zip", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/x-7z-compressed", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/vnd.rar", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/x-rar-compressed", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/x-tar", routeName, label: () => $gettext("Browse archive"), hasPriority: true },
          { mimeType: "application/gzip", routeName, label: () => $gettext("Browse archive"), hasPriority: true }
        ],
      },
      routes: [
        {
          path: "/:driveAliasAndItem(.*)?",
          component: AppWrapperRoute(ArchiveViewer, {
            applicationId: appId,
            disableAutoSave: true,
          }),
          name: routeName,
          meta: {
            authContext: "hybrid",
            title: $gettext("File Archiver"),
            patchCleanPath: true,
          },
        },
      ],
      translations,
      extensions,
    };
  },
});
