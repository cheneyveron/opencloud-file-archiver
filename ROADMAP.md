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
rebuild between acceptance and publication.

### RM-004 — OpenCloud Web and extension protocol compatibility

Test only the latest OpenCloud formal stable release as the release gate. Core Web patches remain
optional; the unpatched host is the mandatory baseline.

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
