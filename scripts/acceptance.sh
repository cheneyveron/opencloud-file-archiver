#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCK_FILE="$ROOT_DIR/compatibility.lock.yaml"
COMPOSE_FILE="$ROOT_DIR/tests/e2e/compose.yaml"
WEB_SOURCE_DIR="$ROOT_DIR/web-app-file-archiver"
SERVICE_DIR="$ROOT_DIR/file-archiver-service"

FRONTEND_ZIP=""
BACKEND_IMAGE=""
OPEN_CLOUD_IMAGE_ARG=""
KEEP_ENVIRONMENT=${ACCEPTANCE_KEEP_ENVIRONMENT:-0}

usage() {
  printf '%s\n' \
    'OpenCloud File Archiver full acceptance' \
    '' \
    'Usage:' \
    '  scripts/acceptance.sh' \
    '  scripts/acceptance.sh --frontend-zip /absolute/file-archiver-X.Y.Z.zip \' \
    '    --backend-image ghcr.io/example/file-archiver@sha256:...' \
    '' \
    'Options:' \
    '  --frontend-zip PATH    Install and test this already-built release ZIP.' \
    '  --backend-image IMAGE  Install and test this already-built backend image.' \
    '  --opencloud-image REF  Override compatibility.lock.yaml for local debugging.' \
    '  --keep-environment     Keep the disposable Compose environment after exit.' \
    '  -h, --help             Show this help.'
}

# OpenCloud File Archiver full acceptance
#
# Usage:
#   scripts/acceptance.sh
#   scripts/acceptance.sh --frontend-zip /absolute/file-archiver-X.Y.Z.zip \
#     --backend-image ghcr.io/example/file-archiver@sha256:...
#
# Options:
#   --frontend-zip PATH    Install and test this already-built release ZIP.
#   --backend-image IMAGE  Install and test this already-built backend image.
#   --opencloud-image REF  Override compatibility.lock.yaml for local debugging.
#   --keep-environment     Keep the disposable Compose environment after exit.
#   -h, --help             Show this help.
#
# With no artifact options, the script builds each candidate once from the
# current checkout. Source tests and security gates always run, including when
# release artifacts are supplied.

while (($#)); do
  case "$1" in
    --frontend-zip)
      [[ $# -ge 2 ]] || { echo "missing value for --frontend-zip" >&2; exit 2; }
      FRONTEND_ZIP=$2
      shift 2
      ;;
    --backend-image)
      [[ $# -ge 2 ]] || { echo "missing value for --backend-image" >&2; exit 2; }
      BACKEND_IMAGE=$2
      shift 2
      ;;
    --opencloud-image)
      [[ $# -ge 2 ]] || { echo "missing value for --opencloud-image" >&2; exit 2; }
      OPEN_CLOUD_IMAGE_ARG=$2
      shift 2
      ;;
    --keep-environment)
      KEEP_ENVIRONMENT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  echo "acceptance: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

yaml_value() {
  local section=$1 key=$2
  awk -v wanted_section="$section" -v wanted_key="$key" '
    /^[^[:space:]#][^:]*:/ {
      current = $0
      sub(/:.*/, "", current)
    }
    current == wanted_section && $0 ~ "^[[:space:]]+" wanted_key ":[[:space:]]*" {
      value = $0
      sub("^[[:space:]]+" wanted_key ":[[:space:]]*", "", value)
      sub(/[[:space:]]+#.*/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      quote = sprintf("%c", 39)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == quote && substr(value, length(value), 1) == quote)) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$LOCK_FILE"
}

require_command awk
require_command curl
require_command flock
require_command jq
require_command node
require_command realpath
require_command sha256sum
require_command ss
require_command stat
require_command tar

[[ -f "$LOCK_FILE" ]] || die "compatibility lock is missing: $LOCK_FILE"
(cd "$ROOT_DIR" && node .github/compatibility/read-lock.mjs >/dev/null)
[[ $(yaml_value opencloud channel) == stable ]] || die "compatibility lock must target the stable OpenCloud channel"

GO_VERSION=$(yaml_value toolchains go)
NODE_VERSION=$(yaml_value toolchains node)
PNPM_VERSION=$(yaml_value toolchains pnpm)
GO_MODULE_MINIMUM=$(yaml_value toolchains go_module_minimum)
GO_TOOL_IMAGE=$(yaml_value toolchains go_image)
NODE_TOOL_IMAGE=$(yaml_value toolchains node_image)
PLAYWRIGHT_TOOL_IMAGE=$(yaml_value toolchains playwright_image)
CADDY_TOOL_IMAGE=$(yaml_value toolchains caddy_image)
TRIVY_TOOL_IMAGE=$(yaml_value toolchains trivy_image)
GOVULNCHECK_VERSION=$(yaml_value toolchains govulncheck)
LOCKED_OPEN_CLOUD_IMAGE=$(yaml_value opencloud image)
OPEN_CLOUD_IMAGE=${OPEN_CLOUD_IMAGE_ARG:-${OPENCLOUD_IMAGE:-$LOCKED_OPEN_CLOUD_IMAGE}}

[[ -n "$GO_VERSION" ]] || die "toolchains.go is missing from compatibility.lock.yaml"
[[ -n "$NODE_VERSION" ]] || die "toolchains.node is missing from compatibility.lock.yaml"
[[ -n "$PNPM_VERSION" ]] || die "toolchains.pnpm is missing from compatibility.lock.yaml"
[[ -n "$GO_TOOL_IMAGE" ]] || die "toolchains.go_image is missing from compatibility.lock.yaml"
[[ -n "$NODE_TOOL_IMAGE" ]] || die "toolchains.node_image is missing from compatibility.lock.yaml"
[[ -n "$PLAYWRIGHT_TOOL_IMAGE" ]] || die "toolchains.playwright_image is missing from compatibility.lock.yaml"
[[ -n "$CADDY_TOOL_IMAGE" ]] || die "toolchains.caddy_image is missing from compatibility.lock.yaml"
[[ -n "$TRIVY_TOOL_IMAGE" ]] || die "toolchains.trivy_image is missing from compatibility.lock.yaml"
[[ -n "$GOVULNCHECK_VERSION" ]] || die "toolchains.govulncheck is missing from compatibility.lock.yaml"
[[ -n "$OPEN_CLOUD_IMAGE" ]] || die "opencloud.image is missing from compatibility.lock.yaml"

MODULE_GO_VERSION=$(awk '$1 == "go" { print $2; exit }' "$SERVICE_DIR/go.mod")
[[ -n "$MODULE_GO_VERSION" ]] || die "file-archiver-service/go.mod has no go directive"
if [[ -n "$GO_MODULE_MINIMUM" && "$MODULE_GO_VERSION" != "$GO_MODULE_MINIMUM" ]]; then
  die "go.mod minimum $MODULE_GO_VERSION differs from locked minimum $GO_MODULE_MINIMUM"
fi

PACKAGE_MANAGER=$(jq -r '.packageManager // empty' "$WEB_SOURCE_DIR/package.json")
[[ "$PACKAGE_MANAGER" == "pnpm@$PNPM_VERSION" ]] || \
  die "packageManager $PACKAGE_MANAGER differs from locked pnpm@$PNPM_VERSION"

if [[ -n "$FRONTEND_ZIP" ]]; then
  [[ "$FRONTEND_ZIP" == /* ]] || die "--frontend-zip must be an absolute path"
  [[ -f "$FRONTEND_ZIP" ]] || die "frontend ZIP does not exist: $FRONTEND_ZIP"
  FRONTEND_ZIP=$(realpath "$FRONTEND_ZIP")
fi

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  die "Docker is unavailable (direct access and passwordless sudo both failed)"
fi

exec 9>/tmp/opencloud-file-archiver-acceptance.lock
flock -n 9 || die "another file-archiver acceptance run is active"

RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
RUN_DIR="/tmp/opencloud-file-archiver-acceptance-$RUN_ID"
if [[ -n "${ACCEPTANCE_OUTPUT_DIR:-}" ]]; then
  mkdir -p "$ACCEPTANCE_OUTPUT_DIR"
  RESULT_DIR=$(realpath "$ACCEPTANCE_OUTPUT_DIR")
  EXTERNAL_RESULT_DIR=1
else
  RESULT_DIR="$RUN_DIR/results"
  EXTERNAL_RESULT_DIR=0
fi
FAILURE_RESULT_DIR="/tmp/opencloud-file-archiver-acceptance-results-$RUN_ID"
WEB_WORK_DIR="$RUN_DIR/web-app-file-archiver"
APP_EXTRACT_DIR="$RUN_DIR/apps"
ARTIFACT_DIR="$RUN_DIR/artifacts"
COMPOSE_ENV_FILE="$RUN_DIR/compose.env"
PROJECT_NAME="archiver-acceptance-$$-$RANDOM"
LOCAL_BACKEND_IMAGE="opencloud-file-archiver-acceptance:$RUN_ID"
COMPOSE_STARTED=0
BUILT_BACKEND_IMAGE=0

mkdir -p "$RESULT_DIR" "$WEB_WORK_DIR" "$APP_EXTRACT_DIR" "$ARTIFACT_DIR"

compose() {
  "${DOCKER[@]}" compose --env-file "$COMPOSE_ENV_FILE" \
    --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

cleanup() {
  local status=$?
  set +e
  if ((COMPOSE_STARTED)); then
    if ((status != 0)); then
      compose logs --no-color >"$RESULT_DIR/compose.log" 2>&1
    fi
    if [[ "$KEEP_ENVIRONMENT" != 1 ]]; then
      compose down --volumes --remove-orphans --timeout 15 >/dev/null 2>&1
    fi
  fi
  if ((status != 0)); then
    printf '# Full acceptance: FAILED\n\nRun ID: `%s`\n' "$RUN_ID" >"$RESULT_DIR/summary.md"
  fi
  if ((BUILT_BACKEND_IMAGE)) && [[ "$KEEP_ENVIRONMENT" != 1 ]]; then
    "${DOCKER[@]}" image rm --force "$LOCAL_BACKEND_IMAGE" >/dev/null 2>&1
  fi
  if ((status == 0)) && [[ "$KEEP_ENVIRONMENT" != 1 ]]; then
    rm -rf "$RUN_DIR"
  elif ((status != 0)); then
    if [[ "$KEEP_ENVIRONMENT" != 1 && "$EXTERNAL_RESULT_DIR" != 1 ]]; then
      rm -rf "$FAILURE_RESULT_DIR"
      mv "$RESULT_DIR" "$FAILURE_RESULT_DIR"
      rm -rf "$RUN_DIR"
      echo "acceptance: failure diagnostics kept at $FAILURE_RESULT_DIR" >&2
    elif [[ "$KEEP_ENVIRONMENT" != 1 ]]; then
      rm -rf "$RUN_DIR"
      echo "acceptance: failure diagnostics kept at $RESULT_DIR" >&2
    else
      echo "acceptance: failure diagnostics kept at $RESULT_DIR" >&2
    fi
  else
    echo "acceptance: environment kept at $RUN_DIR (Compose project $PROJECT_NAME)" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

log "Copy frontend source into disposable workspace"
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.__mf__temp' \
  -C "$WEB_SOURCE_DIR" -cf - . | tar -C "$WEB_WORK_DIR" -xf -

log "Go $GO_VERSION: test, vet, build and vulnerability scan"
"${DOCKER[@]}" run --rm \
  --user "$(id -u):$(id -g)" \
  --env GOCACHE=/tmp/go-build \
  --env GOMODCACHE=/tmp/go-mod \
  --env GOTOOLCHAIN=local \
  --env GO_VERSION="$GO_VERSION" \
  --env GOVULNCHECK_VERSION="$GOVULNCHECK_VERSION" \
  --volume "$SERVICE_DIR:/src:ro" \
  --workdir /src \
  "$GO_TOOL_IMAGE" \
  sh -c '
    set -eu
    go version
    test "$(go env GOVERSION)" = "go$GO_VERSION"
    go mod download
    go test ./...
    go vet ./...
    go build -trimpath -o /tmp/file-archiver-service ./cmd/file-archiver-service
    GOBIN=/tmp/govuln-bin go install "golang.org/x/vuln/cmd/govulncheck@$GOVULNCHECK_VERSION"
    /tmp/govuln-bin/govulncheck ./...
  '

log "Node $NODE_VERSION / pnpm $PNPM_VERSION: frozen install, audit, types, unit and build"
"${DOCKER[@]}" run --rm \
  --user "$(id -u):$(id -g)" \
  --env CI=1 \
  --env HOME=/tmp/node-home \
  --env COREPACK_HOME=/tmp/corepack \
  --env NODE_VERSION="$NODE_VERSION" \
  --volume "$WEB_WORK_DIR:/work" \
  --workdir /work \
  "$NODE_TOOL_IMAGE" \
  sh -c '
    set -eu
    node --version
    test "$(node --version)" = "v$NODE_VERSION"
    test "$(corepack pnpm --version)" = "'"$PNPM_VERSION"'"
    corepack pnpm install --frozen-lockfile
    corepack pnpm audit --audit-level high
    corepack pnpm run check:types
    corepack pnpm exec vitest run
    corepack pnpm run build
  '

if [[ -z "$FRONTEND_ZIP" ]]; then
  VERSION=$(jq -r '.version' "$WEB_WORK_DIR/package.json")
  FRONTEND_ZIP="$ARTIFACT_DIR/file-archiver-$VERSION.zip"
  log "Package standard release ZIP $FRONTEND_ZIP"
  "${DOCKER[@]}" run --rm \
    --user "$(id -u):$(id -g)" \
    --env GOCACHE=/tmp/go-build \
    --volume "$ROOT_DIR/scripts:/scripts:ro" \
    --volume "$WEB_WORK_DIR/dist:/dist:ro" \
    --volume "$ARTIFACT_DIR:/artifacts" \
    "$GO_TOOL_IMAGE" \
    go run /scripts/package-web.go create /dist "/artifacts/$(basename "$FRONTEND_ZIP")"
fi

log "Validate and install the exact frontend ZIP"
ZIP_PARENT=$(dirname "$FRONTEND_ZIP")
ZIP_BASENAME=$(basename "$FRONTEND_ZIP")
"${DOCKER[@]}" run --rm \
  --user "$(id -u):$(id -g)" \
  --env GOCACHE=/tmp/go-build \
  --volume "$ROOT_DIR/scripts:/scripts:ro" \
  --volume "$ZIP_PARENT:/input:ro" \
  --volume "$APP_EXTRACT_DIR:/output" \
  "$GO_TOOL_IMAGE" \
  go run /scripts/package-web.go extract "/input/$ZIP_BASENAME" /output

if [[ -z "$BACKEND_IMAGE" ]]; then
  BACKEND_IMAGE=$LOCAL_BACKEND_IMAGE
  BUILT_BACKEND_IMAGE=1
  log "Build the candidate backend image once"
  "${DOCKER[@]}" build --pull --tag "$BACKEND_IMAGE" "$SERVICE_DIR"
elif ! "${DOCKER[@]}" image inspect "$BACKEND_IMAGE" >/dev/null 2>&1; then
  log "Pull supplied backend image"
  "${DOCKER[@]}" pull "$BACKEND_IMAGE"
fi

log "Trivy: reject HIGH or CRITICAL findings in the candidate backend image"
TRIVY_CACHE_DIR=${TRIVY_CACHE_DIR:-/tmp/opencloud-file-archiver-trivy-cache}
mkdir -p "$TRIVY_CACHE_DIR"
SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
"${DOCKER[@]}" run --rm \
  --user "$(id -u):$(id -g)" \
  --group-add "$SOCKET_GID" \
  --env HOME=/tmp/trivy-home \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$TRIVY_CACHE_DIR:/tmp/trivy-cache" \
  "$TRIVY_TOOL_IMAGE" \
  image --cache-dir /tmp/trivy-cache --image-src docker --scanners vuln \
  --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$BACKEND_IMAGE"

for ((attempt = 0; attempt < 100; attempt += 1)); do
  E2E_PORT=${E2E_PORT:-$((20000 + RANDOM % 20000))}
  if [[ -z $(ss -H -ltn "sport = :$E2E_PORT") ]]; then
    break
  fi
  unset E2E_PORT
done
[[ -n "${E2E_PORT:-}" ]] || die "could not find a free loopback port"

export OPENCLOUD_IMAGE="$OPEN_CLOUD_IMAGE"
export BACKEND_IMAGE
export E2E_PORT
export E2E_BASE_URL="https://opencloud.test:$E2E_PORT"
export E2E_ADMIN_PASSWORD="Archiver-Acceptance-${RUN_ID}!"
export E2E_WEB_CONFIG="$RUN_DIR/opencloud.web.config.json"
export E2E_APPS_CONFIG="$ROOT_DIR/tests/e2e/opencloud.apps.yaml"
export E2E_APP_DIR="$APP_EXTRACT_DIR/file-archiver"
export CADDY_IMAGE="$CADDY_TOOL_IMAGE"

printf '%s\n' \
  "OPENCLOUD_IMAGE=$OPENCLOUD_IMAGE" \
  "BACKEND_IMAGE=$BACKEND_IMAGE" \
  "E2E_PORT=$E2E_PORT" \
  "E2E_BASE_URL=$E2E_BASE_URL" \
  "E2E_ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD" \
  "E2E_WEB_CONFIG=$E2E_WEB_CONFIG" \
  "E2E_APPS_CONFIG=$E2E_APPS_CONFIG" \
  "E2E_APP_DIR=$E2E_APP_DIR" \
  "CADDY_IMAGE=${CADDY_IMAGE:-}" >"$COMPOSE_ENV_FILE"

jq -n --arg url "$E2E_BASE_URL" '{
  server: $url,
  theme: ($url + "/themes/opencloud/theme.json"),
  openIdConnect: {
    metadata_url: ($url + "/.well-known/openid-configuration"),
    authority: $url,
    client_id: "web",
    response_type: "code",
    scope: "openid profile email"
  },
  apps: ["files", "text-editor", "pdf-viewer", "search", "external", "admin-settings"]
}' >"$E2E_WEB_CONFIG"

log "Start one disposable OpenCloud stable environment"
COMPOSE_STARTED=1
compose up --detach --remove-orphans

deadline=$((SECONDS + 300))
is_environment_ready() {
  local graph_status
  curl --resolve "opencloud.test:$E2E_PORT:127.0.0.1" \
    --silent --show-error --insecure --fail \
    "$E2E_BASE_URL/.well-known/openid-configuration" >/dev/null 2>&1 || return 1
  curl --resolve "opencloud.test:$E2E_PORT:127.0.0.1" \
    --silent --show-error --insecure --fail \
    "$E2E_BASE_URL/archive/healthz" >/dev/null 2>&1 || return 1
  graph_status=$(
    printf 'user = "admin:%s"\n' "$E2E_ADMIN_PASSWORD" | \
      curl --config - --resolve "opencloud.test:$E2E_PORT:127.0.0.1" \
        --silent --insecure --output /dev/null --write-out '%{http_code}' \
        "$E2E_BASE_URL/graph/v1.0/users/admin" 2>/dev/null
  )
  [[ "$graph_status" == 200 ]]
}

until is_environment_ready; do
  if ((SECONDS >= deadline)); then
    compose ps >&2
    die "OpenCloud or file-archiver did not become ready within 300 seconds"
  fi
  sleep 2
done

curl --resolve "opencloud.test:$E2E_PORT:127.0.0.1" \
  --silent --show-error --insecure --fail \
  "$E2E_BASE_URL/web/apps/file-archiver/manifest.json" >/dev/null

PLAYWRIGHT_VERSION=$(awk '
  match($0, /@playwright\/test@[0-9]+\.[0-9]+\.[0-9]+/) {
    value = substr($0, RSTART, RLENGTH)
    sub(/@playwright\/test@/, "", value)
    print value
    exit
  }
' "$WEB_WORK_DIR/pnpm-lock.yaml")
[[ -n "$PLAYWRIGHT_VERSION" ]] || die "could not resolve @playwright/test from pnpm-lock.yaml"
[[ "$PLAYWRIGHT_TOOL_IMAGE" == *":v$PLAYWRIGHT_VERSION-"* ]] || \
  die "locked Playwright image does not match @playwright/test $PLAYWRIGHT_VERSION"

log "Playwright Chromium happy path against installed ZIP and backend image"
"${DOCKER[@]}" run --rm \
  --network host \
  --ipc host \
  --add-host opencloud.test:127.0.0.1 \
  --user "$(id -u):$(id -g)" \
  --env CI=1 \
  --env HOME=/tmp/playwright-home \
  --env E2E_BASE_URL="$E2E_BASE_URL" \
  --env E2E_DIRECT_BASE_URL="$E2E_BASE_URL" \
  --env E2E_USERNAME=admin \
  --env E2E_PASSWORD="$E2E_ADMIN_PASSWORD" \
  --env E2E_RESULTS_DIR=/results/test-results \
  --env E2E_REPORT_DIR=/results/playwright-report \
  --volume "$WEB_WORK_DIR:/work" \
  --volume "$RESULT_DIR:/results" \
  --workdir /work \
  "$PLAYWRIGHT_TOOL_IMAGE" \
  ./node_modules/.bin/playwright test --config tests/e2e/playwright.config.ts

FRONTEND_SHA256=$(sha256sum "$FRONTEND_ZIP" | awk '{ print $1 }')
BACKEND_IMAGE_ID=$("${DOCKER[@]}" image inspect --format '{{.Id}}' "$BACKEND_IMAGE")
jq -n \
  --arg status passed \
  --arg opencloud_image "$OPEN_CLOUD_IMAGE" \
  --arg frontend_zip "$FRONTEND_ZIP" \
  --arg frontend_sha256 "$FRONTEND_SHA256" \
  --arg backend_image "$BACKEND_IMAGE" \
  --arg backend_image_id "$BACKEND_IMAGE_ID" \
  --arg go "$GO_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg pnpm "$PNPM_VERSION" \
  --arg playwright "$PLAYWRIGHT_VERSION" \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    status: $status,
    completed_at_utc: $completed_at,
    opencloud_image: $opencloud_image,
    frontend: {zip: $frontend_zip, sha256: $frontend_sha256},
    backend: {image: $backend_image, image_id: $backend_image_id},
    toolchains: {go: $go, node: $node, pnpm: $pnpm, playwright: $playwright}
  }' >"$RESULT_DIR/resolved-components.json"

printf '# Full acceptance: PASSED\n\n- OpenCloud: `%s`\n- Frontend SHA256: `%s`\n- Backend image: `%s`\n' \
  "$OPEN_CLOUD_IMAGE" "$FRONTEND_SHA256" "$BACKEND_IMAGE" >"$RESULT_DIR/summary.md"

log "FULL ACCEPTANCE PASSED"
printf 'OpenCloud: %s\nFrontend ZIP: %s\nBackend image: %s\n' \
  "$OPEN_CLOUD_IMAGE" "$FRONTEND_ZIP" "$BACKEND_IMAGE"
