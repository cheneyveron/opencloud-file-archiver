# Deploy

`docker-compose.file-archiver.example.yml` shows the additional pieces needed by an
existing OpenCloud deployment:

- Mount `../web-app-file-archiver/dist` to `/web/apps/file-archiver`.
- Run `file-archiver-service` as a separate container from the published GHCR image.
- Route `/archive` to `file-archiver-service` through Traefik.

Build the web extension before starting OpenCloud:

```sh
cd ../web-app-file-archiver
pnpm install
pnpm build
```

The Web extension requires the companion backend service. Download the matching frontend ZIP and
pin the backend image from the same numbered GitHub Release; `main` is not a release channel:

```sh
FILE_ARCHIVER_VERSION=X.Y.Z docker compose -f docker-compose.file-archiver.example.yml up -d
```

See [`INSTALL.md`](../INSTALL.md) for checksum verification, the required ZIP layout, configuration,
smoke testing, upgrade, and rollback instructions.

OpenCloud Web discovers apps under `WEB_ASSET_APPS_PATH` by reading each app's
`manifest.json` and injecting it into `external_apps`. The example
`opencloud.web.config.example.json` therefore keeps only the core app list.

`opencloud.apps.file-archiver.example.yaml` shows optional per-app config for the file archiver
extension. Merge it into your existing `apps.yaml` if you need to override defaults.
