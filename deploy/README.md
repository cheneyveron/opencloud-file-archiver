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

The service image is published on every relevant `main` branch push:

```sh
ghcr.io/cheneyveron/opencloud-file-archiver-service:main
```

OpenCloud Web discovers apps under `WEB_ASSET_APPS_PATH` by reading each app's
`manifest.json` and injecting it into `external_apps`. The example
`opencloud.web.config.example.json` therefore keeps only the core app list.

`opencloud.apps.file-archiver.example.yaml` shows optional per-app config for the file archiver
extension. Merge it into your existing `apps.yaml` if you need to override defaults.
