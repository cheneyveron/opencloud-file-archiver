# Core Web Patches

These patches contain platform-level OpenCloud Web changes required by the archive extension
when the target OpenCloud Web version does not already include equivalent capabilities.

Apply from the root of the `web` source tree:

```sh
git apply /path/to/opencloud-file-archiver/core-web-patches/0001-context-action-submenu.patch
git apply /path/to/opencloud-file-archiver/core-web-patches/0002-runtime-snackbar-extension-point.patch
git apply /path/to/opencloud-file-archiver/core-web-patches/0003-location-picker-filename-support.patch
git apply /path/to/opencloud-file-archiver/core-web-patches/0004-embed-snackbar-offset.patch
```

Patch contents:

- `0001-context-action-submenu.patch`: adds one-level child actions for context-menu submenus.
- `0002-runtime-snackbar-extension-point.patch`: adds `app.runtime.snackbars` so extensions can render task panels near existing upload progress.
- `0003-location-picker-filename-support.patch`: lets the location picker return a chosen file name and location query data.
- `0004-embed-snackbar-offset.patch`: moves runtime snackbars above embedded picker actions.

These patches are intentionally generic and contain no archive-specific business logic.
