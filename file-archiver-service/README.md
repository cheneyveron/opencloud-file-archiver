# OpenCloud File Archiver Service

Backend file archiver job service for OpenCloud Web extensions.

It performs compression and extraction with the user's OpenCloud authorization
header. It never writes directly to OpenCloud POSIX storage; all reads and
writes go through WebDAV.

## Supported Formats

- Compress: `.zip`, encrypted `.zip` with AES-256, `.tar.gz`
- Extract: `.zip`, `.7z`, `.tar`, `.tar.gz` / `.tgz`, `.gz`

RAR and ZipCrypto are intentionally not supported.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `FILE_ARCHIVER_OPENCLOUD_URL` | `OPENCLOUD_URL` | OpenCloud base URL for WebDAV |
| `FILE_ARCHIVER_TMP_DIR` | OS temp dir | Local temp directory for archive spools |
| `FILE_ARCHIVER_MAX_ARCHIVE_BYTES` | `20000000000` | Maximum archive input size |
| `FILE_ARCHIVER_MAX_OUTPUT_BYTES` | `100000000000` | Maximum extracted output per job |
| `FILE_ARCHIVER_MAX_ENTRY_BYTES` | `20000000000` | Maximum single extracted entry size |
| `FILE_ARCHIVER_MAX_PREVIEW_BYTES` | `50000000` | Maximum single entry size streamed for inline preview |
| `FILE_ARCHIVER_MAX_ENTRIES` | `100000` | Maximum entries per job |
| `FILE_ARCHIVER_MAX_CONCURRENT_JOBS` | `2` | Concurrent worker limit |
| `FILE_ARCHIVER_DAV_REQUEST_TIMEOUT` | `6h` | Maximum duration for a single WebDAV request, including streamed bodies |
| `FILE_ARCHIVER_DAV_HEADER_TIMEOUT` | `30s` | Maximum time to wait for WebDAV response headers |
| `FILE_ARCHIVER_DOWNLOAD_TOKEN_TTL` | `10m` | Lifetime for unauthenticated one-time download URLs |
| `FILE_ARCHIVER_ZIP_AES_BUFFER_LIMIT` | `512000000` | AES ZIP compressed-entry size before using deferred auth |
| `FILE_ARCHIVER_JOB_TTL` | `1h` | Finished job retention |

Legacy `ARCHIVE_*` variables are still accepted for compatibility.

## API

All endpoints require `Authorization`.

```http
POST   /archive/api/extractions
POST   /archive/api/compressions
POST   /archive/api/previews
GET    /archive/api/previews/{previewId}
GET    /archive/api/previews/{previewId}/entries
GET    /archive/api/previews/{previewId}/entries/{entryId}/content
DELETE /archive/api/previews/{previewId}
GET    /archive/api/jobs
GET    /archive/api/jobs/{jobId}
DELETE /archive/api/jobs/{jobId}
GET    /archive/api/jobs/events
GET    /archive/api/jobs/{jobId}/download
```

The legacy unzip polling endpoint is also available for compatibility:

```http
GET    /archive/api/extractions/{jobId}
DELETE /archive/api/extractions/{jobId}
```

## Local Test

```sh
go test ./...
PORT=8080 FILE_ARCHIVER_OPENCLOUD_URL=https://host.docker.internal:9200 go run ./cmd/file-archiver-service
```
