# Core Web Patches

These patches contain optional platform-level OpenCloud Web changes used for native
integration experiments and upstreaming. The archive extension no longer requires these
patches to run.

Without these patches, the extension uses compatibility fallbacks:

- archive actions are registered as a flat list unless `fileArchiverUseNestedActions` is enabled
- archive file names are requested by the extension when the location picker does not return one
- archive job progress is shown in the extension's floating task panel when
  `app.runtime.snackbars` is unavailable

Apply patches only when you want to test the corresponding Core Web behavior in a matching
OpenCloud Web source tree.

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
