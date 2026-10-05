# Maintenance and Compatibility Roadmap

This roadmap is also an automation boundary. Every pull request names one or more IDs below;
the required `Automated review / policy` check rejects files outside their registered scopes.

## Active work

### RM-001 — Dependency and supply-chain maintenance

Track Go, npm/pnpm, container base images, GitHub Actions, deprecated packages, retracted Go
modules, and archived source repositories. Non-breaking updates are grouped into one weekly PR.
Major or otherwise breaking updates require a separate impact assessment.

Acceptance: dependency scans, backend tests/vet/build, frontend types/unit/build, stable OpenCloud
compatibility, and exact release-artifact acceptance.

### RM-002 — Browser E2E happy path

Maintain a deterministic browser test that creates an archive, observes job completion, browses
and previews it, extracts selected content, and validates a direct download against an ephemeral
OpenCloud stable deployment. The same harness is used by release acceptance.

Acceptance: no external long-lived test state; fixtures are seeded and removed per run; failure
artifacts include browser trace, screenshots, service logs, and resolved component versions.

### RM-003 — CI, release, installation, and operations automation

Keep PR validation read-only, run the single weekly maintenance schedule, and publish immutable
versioned frontend ZIP/checksum and multi-architecture backend images only after acceptance.

Acceptance: no `pull_request_target`, no PR secrets, least-privilege workflow permissions, and no
rebuild between acceptance and publication. Scheduled discovery always runs; full acceptance is
needed only for an unaccepted source/upstream combination or for release. Exact release artifacts
are always reaccepted, independently of previous scheduled results.

### RM-004 — OpenCloud Web and extension protocol compatibility

Test the latest official stable backend with the independently latest formal OpenCloud Web release.
Resolve both at each acceptance run; no stored upstream version or Web-major cap is a release gate.
Core Web patches remain optional; the unpatched host is the mandatory baseline.

Acceptance: manifest discovery, ESM Module Federation load, context actions, location picker,
request-header forwarding, task UI fallback, and file-list refresh all pass.

### RM-005 — Archive format and backend hardening

Extend real integration fixtures across ZIP/AES ZIP, tar.gz, 7z, RAR, gzip, cancellation, resource
limits, auth isolation, and malformed/path-traversal archives.

Acceptance: no regression in the full archive matrix and no relaxation of existing safety limits.

## Release decisions

- Patch/minor dependency updates with no detected breaking change may automerge after every
  required check succeeds.
- Critical/High runtime vulnerabilities use `security:critical` or `security:high`, must cite a
  GHSA/CVE, and trigger release immediately after merge and full acceptance.
- Medium/Low and development-only vulnerabilities join the weekly batch unless a maintainer
  explicitly escalates them.
- Archived, disabled, retracted, or deprecated dependencies block automatic release until migrated
  and generate a maintenance issue; a missing approved replacement also requires a maintainer
  decision.
- A major dependency or OpenCloud breaking change never automerges and must add a new roadmap
  decision before implementation.

## Web 8 and pnpm 12 compatibility decision

The September 2026 migration upgrades the OpenCloud extension SDK, Web client, Web package,
TypeScript configuration, and test helpers together to v8. The packages share stores and test
injection state; updating Web and test helpers independently can load incompatible Pinia copies.

pnpm is an extension build tool, not a shared browser runtime. Approve pnpm 12 with its exact
version recorded in both packageManager and the compatibility lock. Actual frontend builds and
latest-host E2E establish compatibility; an older upstream toolchain baseline does not cap upgrades.
Future breaking toolchain updates still require a roadmap decision and never automerge.

Acceptance requires frozen installs, types, unit tests, the exact release ZIP, and browser archive
operations against the latest official backend and Web assets on the unpatched disposable host.
Upstream releases are discovered each run and recorded in the acceptance evidence.

## Vitest 5 compatibility decision

Approve the isolated migration of the extension's development-only unit-test runner to Vitest 5.
The OpenCloud extension SDK and test helpers remain on their jointly approved v8 release; SDK 8
supports Vitest 4 and 5, and the locked Node 24 and Vite 8 toolchains meet Vitest 5 requirements.
This decision does not change the plugin's runtime features or the stable OpenCloud target.

Preserve every existing unit assertion and the SDK's happy-dom environment and mock isolation.
Vitest 5 changes worker defaults, mock-reset behavior, and several test APIs, so acceptance requires
an unchanged test count, frontend type checking/build, dependency security checks, and the complete
archive browser flow on the latest official backend and Web releases on an unpatched host.
Keep the update separate from other dependency changes and merge it manually only after the exact
final revision passes all required checks. Release-artifact acceptance remains mandatory.

References: [Vitest 5 migration guide](https://vitest.dev/guide/migration.html) and
[OpenCloud SDK 8 peer dependencies](https://github.com/opencloud-eu/web/blob/v8.0.0/packages/extension-sdk/package.json).

## NanoID legacy override maintenance decision

The October 2026 review retains the `nanoid@<3.3.18` security override on the maintained 3.x
line, with a minimum target of 3.3.19. [PostCSS 8.5.28](https://github.com/postcss/postcss/blob/8.5.28/package.json)
requests NanoID `^3.3.18` and already resolves to 3.3.19. Changing the older-version override to
6.x would not improve that resolution and would introduce an unnecessary major-version override
for future legacy consumers. [NanoID 3.3.19](https://github.com/ai/nanoid/releases/tag/3.3.19)
remains an upstream-maintained patch release.

Limit only this override's Renovate target to `>=3.3.19 <4.0.0`. Do not constrain direct NanoID
requirements or other consumers: packages already requesting NanoID 6 continue on their own
compatible release line. Keep patch updates enabled with the existing weekly and advisory-severity
routing, required checks, and full acceptance. This decision does not suppress vulnerability
scanning or authorize releasing a vulnerable version. If 3.x loses maintenance or a required fix
is unavailable on that line, block release and require a new migration decision.

## Renovate 44 compatibility and registry decision

The October 2026 maintenance review approves the isolated move from Renovate 43.257.7 to
44.132.2. [Upstream confirms that 44.0.0 was an accidental major release with no breaking
change](https://github.com/renovatebot/renovate/discussions/44952) and that 44 continues the
43 release line; no more 43 releases are expected. This decision does not authorize later
breaking releases or relax the default manual major-update review.

44.132.2 includes the fixes for [GHSA-6j6f-fh7w-vvjr](https://github.com/renovatebot/renovate/security/advisories/GHSA-6j6f-fh7w-vvjr)
and [GHSA-mpf8-qxrw-gq3w](https://github.com/renovatebot/renovate/security/advisories/GHSA-mpf8-qxrw-gq3w).
The latter's Docker binary-source/import-path-update attack path is not enabled here.
It also incorporates strict minimum-age fixes such as
[GHSA-g4qr-hw2h-687r](https://github.com/renovatebot/renovate/security/advisories/GHSA-g4qr-hw2h-687r).
The existing bot identity, repository scope, permissions, schedules, and security/merge gates
remain unchanged; the automation image is still pinned by digest.

Use the [official Docker Hub distribution](https://docs.renovatebot.com/getting-started/running/#docker-images)
`renovate/renovate` so the Docker datasource can obtain release timestamps. GHCR does not
supply the timestamps needed by the existing three-day minimum-age gate and can leave the
self-update pending indefinitely. The 44.132.2 Docker Hub and GHCR manifests have the same
SHA256 digest and amd64/arm64 child manifests. Docker Hub reports publication on
2026-10-02 at 08:25 UTC, more than three days before this review. Preserve the three-day gate;
do not use a missing-timestamp exemption or widen automatic major-version approval.

Acceptance requires the complete policy tests against the actual pinned Renovate image,
including extraction, weekly grouping, security routing, and future-major isolation, plus
both CodeQL analyses and full latest-host archive acceptance. Keep every existing assertion.


## Go 1.26 source minimum and x/crypto maintenance decision

Approve raising the backend module's source-build minimum from Go 1.25 to Go 1.26 so it
can use `golang.org/x/crypto` 0.56.0, whose upstream module requires Go 1.26.0. The release
compiler and container builder remain pinned to the already compatible Go 1.27.1.
This maintenance change preserves the plugin's features, archive formats, and OpenCloud
integration; source developers need Go 1.26 or newer.

The update removes the dependency-level SSH denial-of-service findings
[GO-2026-6354](https://pkg.go.dev/vuln/GO-2026-6354) and
[GO-2026-6355](https://pkg.go.dev/vuln/GO-2026-6355). The archiver does not import the
vulnerable SSH package; this is preventive dependency maintenance, not a claim of a reachable
runtime vulnerability. The unrelated unused OpenPGP package finding remains reported by
module-level scanning and is not suppressed.

Acceptance preserves every existing regression and adds fixed-ciphertext AES-256 ZIP checks
for correct-password preview/extraction and wrong-password rejection without WebDAV uploads.
Run the full suite on the Go 1.26 source baseline and locked release compiler, plus race tests,
vet/build, fresh vulnerability scans, frontend checks, both CodeQL analyses, and full acceptance
on the latest official OpenCloud backend and Web. Exact release artifacts must pass acceptance
again before publication.
