# opencloud-file-archiver

File archiver support for OpenCloud.

This package is split into:

- `file-archiver-service`: backend companion service for compression, extraction, progress and cancellation.
- `web-app-file-archiver`: OpenCloud Web extension registering archive context actions and the task panel.
- `core-web-patches`: optional OpenCloud Web platform patches for native integration experiments and upstreaming.
- `deploy`: deployment examples for Docker Compose style environments.

The backend is a separate service. The frontend extension talks to it through `/archive`
by default and can be configured with `fileArchiverServiceUrl`.

Build order:

1. Build `web-app-file-archiver` and deploy its `dist` directory as `WEB_ASSET_APPS_PATH/file-archiver`.
2. Build and run `file-archiver-service`.
3. Route `/archive` to `file-archiver-service`.

Core Web patches are not required. The extension defaults to flat context actions, asks for
the archive file name itself when the location picker does not return one, and falls back to
its own floating task panel when `app.runtime.snackbars` is not available. If a target Web
build supports context action `children`, you can opt into nested archive menus with
`fileArchiverUseNestedActions: true`.
