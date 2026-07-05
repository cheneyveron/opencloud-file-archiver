# opencloud-file-archiver

File archiver support for OpenCloud.

This package is split into:

- `file-archiver-service`: backend companion service for compression, extraction, progress and cancellation.
- `web-app-file-archiver`: OpenCloud Web extension registering archive context actions and the task panel.
- `core-web-patches`: required OpenCloud Web platform patches when the target Web version does not already provide these extension capabilities.
- `deploy`: deployment examples for Docker Compose style environments.

The backend is a separate service. The frontend extension talks to it through `/archive`
by default and can be configured with `fileArchiverServiceUrl`.

Build order:

1. Apply the patches in `core-web-patches` to the matching OpenCloud Web source tree, then rebuild OpenCloud Web.
2. Build `web-app-file-archiver` and deploy its `dist` directory as `WEB_ASSET_APPS_PATH/file-archiver`.
3. Build and run `file-archiver-service`.
4. Route `/archive` to `file-archiver-service`.
