# Installing OpenCloud File Archiver

Use a numbered GitHub Release. Do not install from a branch artifact or the mutable backend
`main`/`latest` tag when reproducibility matters.

## Release assets

Release `X.Y.Z` contains:

- `file-archiver-X.Y.Z.zip`
- `file-archiver-X.Y.Z.zip.sha256`
- `ghcr.io/cheneyveron/opencloud-file-archiver-service:X.Y.Z`

The ZIP has one top-level directory named `file-archiver/`; that directory contains
`manifest.json`, the hashed ESM Module Federation entrypoint, JavaScript chunks, and CSS assets.
The manifest carries a machine-readable backend disclosure and installation link. Current
OpenCloud releases only consume its entrypoint; the same warning is therefore also shown by the
extension when its backend health check fails and is published in App Store catalog metadata.
The container tag is a multi-architecture manifest for Linux amd64 and arm64.
The companion backend is mandatory: installing only the Web ZIP leaves all archive operations
without an execution service.

Every formal Release also includes `file-archiver-app-store-entry-X.Y.Z.json`. It is a validated
catalog entry with the exact ZIP URL, minimum accepted OpenCloud version, and backend warning.
OpenCloud's default App Store catalog is maintained separately in `opencloud-eu/awesome-apps` and
downloads rather than installs ZIPs; publishing this repository therefore generates the reviewed
catalog input but never writes to that separately owned project without explicit authorization.

## Verify and unpack the frontend

```sh
version=X.Y.Z
sha256sum --check "file-archiver-${version}.zip.sha256"
unzip -q "file-archiver-${version}.zip" -d /path/to/opencloud-web-apps
test -s /path/to/opencloud-web-apps/file-archiver/manifest.json
```

Mount `/path/to/opencloud-web-apps` at the OpenCloud `WEB_ASSET_APPS_PATH`. OpenCloud accepts an
application directory containing `manifest.json`; a Web service restart is required after adding
or replacing an external application.

## Configure the backend

Pin the exact release tag:

```yaml
services:
  file-archiver:
    image: ghcr.io/cheneyveron/opencloud-file-archiver-service:X.Y.Z
    environment:
      FILE_ARCHIVER_OPENCLOUD_URL: https://opencloud.example.com
      FILE_ARCHIVER_TMP_DIR: /tmp/opencloud-file-archiver
      FILE_ARCHIVER_MAX_CONCURRENT_JOBS: "2"
```

Route same-origin `/archive` to port 8080 of this service. Strip the `/archive` prefix only if the
reverse proxy configuration matches the deployment example; the service accepts both prefixed and
unprefixed API paths.

## Configure the OpenCloud app

Merge this into OpenCloud `apps.yaml`:

```yaml
file-archiver:
  config:
    fileArchiverServiceUrl: /archive
    archivePollIntervalMs: 2000
```

Restart the OpenCloud Web service, sign in, and confirm:

1. `file-archiver/manifest.json` and its `.mjs` entrypoint return HTTP 200.
2. `/archive/healthz` returns `{"status":"ok"}`.
3. A selected downloadable file shows archive actions.
4. Creating and extracting a small ZIP reaches `succeeded` and refreshes the file list.

## Upgrade and rollback

Keep the previous frontend directory and immutable image tag until the smoke test passes. Upgrade
the ZIP and backend image as one unit. To roll back, restore both previous versions and restart the
OpenCloud Web service; do not mix frontend and backend versions unless that combination is recorded
as validated in `compatibility.lock.yaml`.
