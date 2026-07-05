import { defineConfig } from "@opencloud-eu/extension-sdk";

export default defineConfig({
  name: "file-archiver",
  test: {
    exclude: ["**/e2e/**"],
  },
});
