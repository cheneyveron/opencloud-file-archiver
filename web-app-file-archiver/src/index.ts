import { useGettext } from "vue3-gettext";
import translations from "../l10n/translations.json";
import { defineWebApplication } from "@opencloud-eu/web-pkg";
import { useExtensions } from "./composables/useExtensions";

export default defineWebApplication({
  setup(options) {
    const { $gettext } = useGettext();
    const extensions = useExtensions(options);

    return {
      appInfo: {
        name: $gettext("File Archiver"),
        id: "file-archiver",
      },
      translations,
      extensions,
    };
  },
});
