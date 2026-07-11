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
Monday; their trusted severity label enters the immediate post-merge release path.

## Branch protection / ruleset

Protect `main`, require pull requests, and require these exact checks:

- `Automated review / policy`
- `Full acceptance / locked OpenCloud stable`

Require the branch to be current before merge and prevent bypass by the Renovate bot. Renovate may
enable platform automerge, but GitHub will merge only after both checks pass. Do not require a human
approval: that would stop the weekly unattended path. Keep CODEOWNERS advisory, require resolution
of review threads, and set the required approval count to zero. Limit application of
`review:automation`, `security:high`, and `security:critical` to trusted maintainers and the
dedicated Renovate identity. Renovate adds `review:automation` only to its generated workflow-action
and compatibility-lock updates; anything Renovate classifies as breaking still cannot automerge,
including pre-release transitions that do not have a `major` update type.

Never change PR validation to `pull_request_target`. It intentionally has read-only contents access,
does not persist checkout credentials, and receives no repository secrets.

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
PR policy. Low/Medium non-major fixes receive `release:weekly`; High/Critical non-major fixes
receive the urgent security label. These known-severity, non-major updates request GitHub
auto-merge, which remains blocked until the required policy and full-acceptance checks pass. A
major, unclassified, stale, unsigned, cross-repository, or ambiguous update never requests
auto-merge and receives `roadmap:required` or fails closed.

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
is pending and main changed, it invokes the full acceptance workflow itself. Otherwise the accepted
`release:weekly` PR merge invokes that same release workflow after every other weekly PR is closed,
so one accepted batch is published after its required checks rather than waiting for the next
Monday. Duplicate queued weekly or urgent releases become no-ops when the latest version tag already
points at current main.

A merged PR labeled `security:high` or `security:critical` invokes the same workflow immediately.
Maintainers can also dispatch `release.yml` with `release_kind=urgent`. Urgency never skips full
acceptance.

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
