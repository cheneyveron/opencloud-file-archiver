# Repository Automation Setup

The workflows are safe-by-default but require repository configuration before enabling automatic
maintenance and release.

## Required secret: `RENOVATE_TOKEN`

The single weekly workflow self-hosts Renovate. `GITHUB_TOKEN` must not be substituted: pull
requests created with it do not reliably trigger normal PR/push workflows.

Prefer a dedicated GitHub App installation token or narrowly scoped bot token. It needs repository
contents and pull requests read/write, issues read/write for the dependency dashboard, commit
status/check access, Actions read access, and Dependabot alert read access. Workflow write access is needed only if
Renovate is expected to update GitHub Actions references. Store the token only as the repository
Actions secret `RENOVATE_TOKEN`.

The trusted Dependabot `workflow_run` normalizer also uses this identity for its API writes and
auto-merge request. The built-in `GITHUB_TOKEN` is deliberately insufficient here: its edited,
labeled, and closed pull-request events would not start the validation and urgent-release
workflows. A missing `RENOVATE_TOKEN` therefore fails normalization closed. Prefer replacing a PAT
with a narrowly scoped GitHub App installation token when practical, while retaining Dependabot
alerts read, contents/pull-request/issue write, and merge permission.

`renovate.json` deliberately says `schedule: at any time`: Renovate itself is started only by the
one Monday Actions cron, so adding another internal weekly window would create competing schedules.
High/Critical vulnerability PRs can also be created by a trusted security bot or manually before
Monday; their trusted severity label enters the immediate post-merge release path for runtime or
build-chain dependencies.

## Branch protection / ruleset

Protect `main`, require pull requests, and require these exact checks:

- `Automated review / policy`
- `Full acceptance / locked OpenCloud stable`
- `CodeQL / go`
- `CodeQL / javascript-typescript`

Require the branch to be current before merge and prevent bypass by the Renovate bot. Renovate may
enable platform automerge, but GitHub will merge only after all required checks pass. Do not require a human
approval: that would stop the weekly unattended path. Keep CODEOWNERS advisory, require resolution
of review threads, and set the required approval count to zero. Limit application of
`review:automation`, `security:high`, and `security:critical` to trusted maintainers and the
dedicated Renovate identity. Renovate adds `review:automation` only to its generated workflow-action
and compatibility-lock updates. Breaking updates default to manual roadmap review, including
pre-release transitions that do not have a `major` update type. The only exception is an isolated
High/Critical vulnerability update, which can merge only after every required gate passes.

Never change PR validation to `pull_request_target`. It intentionally has read-only contents access,
does not persist checkout credentials, and receives no repository secrets.

`source-security.yml` scans both shipped code paths on every pull request and `main` push: Go uses
CodeQL autobuild, while the Vue/JavaScript/TypeScript sources use database-only extraction. It has
no schedule, repository secrets, shell steps, or third-party actions. Its only write permission is
the narrowly constrained `security-events: write` needed to upload CodeQL results. Enable the
ruleset's native code-scanning gate after the first successful scan on `main`; require CodeQL error
results and block Medium-or-higher security alerts. Keep the two named CodeQL matrix checks required
as a separate fail-closed guard against a skipped or failed analysis upload.

All actions in that workflow are constrained by the default-branch review policy to trusted GitHub
action repositories and immutable full commit SHAs. Renovate may advance those pins directly while
the policy still requires the exact workflow shape, least-privilege permissions, fixed action names,
and one shared CodeQL revision across initialization, autobuild, and analysis. Tags and lookalike
repositories remain invalid.

## Native Dependabot security pull requests

Enable **Dependency graph**, **Dependabot alerts**, **Dependabot security updates**, and repository
**Allow auto-merge**. Native Dependabot security PRs pass through two deliberately separate
workflows:

1. `dependabot-intake.yml` runs on `pull_request` with read-only contents permission. It does not
   check out PR code, use secrets, or upload an artifact whose contents would later be trusted.
2. `dependabot-normalize.yml` runs from the default branch through `workflow_run`. Before its first
   write it re-fetches the workflow, repository, live PR, head SHA, author, branch, changed files,
   and every commit. It accepts only same-repository `dependabot/*` PRs whose commits are authored
   by `dependabot[bot]` and have verified signatures. It never checks out the PR revision.

The normalizer gets advisory severity from the repository's Dependabot alerts API, not from PR
prose. It adds the roadmap, security-impact, advisory, and validation fields required by the base
PR policy. Every dependency in the signed metadata must match an open alert and its patched version
before any automatic merge is requested. Low/Medium non-major fixes receive `release:weekly`;
High/Critical fixes receive the urgent security label. A major update is eligible only when every
major dependency independently matches a High/Critical alert. Eligible updates remain blocked
until policy, both CodeQL analyses, and full acceptance pass. An unmatched, unclassified, stale,
unsigned, cross-repository, ambiguous, or non-urgent major update never requests auto-merge and
receives `roadmap:required` or fails closed.

Workflow files remain an automation boundary. The narrow unattended exception is a verified native
Dependabot `github_actions` update whose complete changed-file set contains only expected workflow
YAML and whose signed dependencies all match alerts. It still receives `review:automation` and must
pass the base workflow policy, both CodeQL analyses, and full acceptance. The exact allowlist on
`source-security.yml` remains stricter, so a new CodeQL action SHA requires the documented two-PR
approval sequence instead of self-approval.

The write-side identity needs Dependabot alerts read permission to resolve advisory severity plus
narrowly scoped PR/issue/content write permissions to update metadata, labels, and the auto-merge
request. The workflow's built-in token remains `contents: read`; the separate identity is exposed
only to the verified default-branch script. Do not replace this split design with
`pull_request_target`, and do not pass artifacts or PR-controlled scripts into the write-side job.

## Acceptance contract

`scripts/acceptance.sh` is the only functional release gate.

- On a PR it is called without artifact arguments and must build and exercise the complete locked
  OpenCloud stable happy path.
- During release it is called with `--frontend-zip <absolute-path>` and
  `--backend-image <ghcr-reference@sha256:digest>` and must deploy those exact inputs.
- It receives the digest-pinned `OPENCLOUD_IMAGE` and an `ACCEPTANCE_OUTPUT_DIR` for traces, logs,
  screenshots, and a machine-readable result.

Unit checks, Trivy, ZIP validation, and manifest validation are prerequisites; none is advertised as
a substitute acceptance process.

## Weekly and urgent releases

The repository has one cron in `weekly-maintenance.yml`. It runs Renovate, audits open PRs and
dependency lifecycle status, reports blockers, and compares main HEAD with the latest `vX.Y.Z`
tag. It updates one rolling blocker issue instead of creating weekly duplicates. When no update PR
is pending and main changed, it invokes the full acceptance workflow itself. An accepted
`release:weekly` merge waits for other passing weekly candidates to auto-merge before it enters the
formal release queue. A candidate with a terminally failed required check is quarantined and cannot
suppress the accepted batch; the settling window is also bounded so a stuck check cannot prevent
release indefinitely. Ordinary application dependencies remain accumulated in one weekly PR;
runtime and build-toolchain updates use a separate compatibility PR. Duplicate queued weekly or
urgent releases become no-ops when the latest version tag already points at current main.

The locked Go compiler scalar, `golang` builder image, and Dockerfile base all resolve through the
same Docker-tag lookup rather than combining a newer scalar release with an older image. Go compiler
releases bypass the general stability delay because `govulncheck` treats reachable standard-library
findings as release blockers; the full compatibility and exact-artifact gates still apply before
merge and publication. `go_module_minimum` remains owned by the tracked OpenCloud stable release and
is not changed by compiler refreshes.

The embedded OpenCloud Web tag must be one stable `vX.Y.Z` release in the explicitly approved
`opencloud.embedded_web_major`. Its package version must match that tag, and the locked Node and
pnpm toolchains must be stable, in the same major as the upstream Volta/package-manager baselines,
and no older. The base-trusted PR policy checks this before compatibility-lock PRs can merge; the
weekly and final release preflight repeat it. Automated PRs cannot advance the approved Web major.
A maintainer must update that allowance, the OpenCloud target/image, and any required toolchains
atomically in an isolated `roadmap:required` PR without an automatic release label. After it passes
full acceptance and merges, the next weekly maintenance run may publish the accepted revision.

A merged PR labeled `security:high` or `security:critical` invokes the same workflow immediately.
Maintainers can also dispatch `release.yml` with `release_kind=urgent`. Urgency never skips full
acceptance.

The post-merge caller deliberately has no workflow-level concurrency group. All release-bearing
callers enter `release.yml`, whose `formal-release` concurrency group uses GitHub's durable
`queue: max` FIFO mode. Each queued run re-resolves current `main`; after one run publishes a
revision, later runs already covered by that tag finish as no-ops. This prevents both dropped urgent
events and duplicate releases without treating an open failed PR as a release barrier.

Configure a `release` GitHub Environment without required reviewers so weekly and urgent releases
remain unattended; do not place build credentials in that environment. Candidate GHCR images are
produced with the workflow token and addressed by digest.

GHCR creates a personal-account container package as private on first publication. After the first
successful release, make `opencloud-file-archiver-service` public once in its package settings and
verify its amd64/arm64 manifest without authentication. Public visibility is permanent and is
required because the installation instructions intentionally use anonymous pulls.

## Artifact identity

The frontend ZIP is built once, uploaded between jobs, accepted, then attached unchanged to the
GitHub Release. The backend is built once as an amd64/arm64 candidate manifest. Acceptance uses its
digest; publication adds `X.Y.Z` and `latest` tags to that same digest with `imagetools create` and
does not rebuild it.
