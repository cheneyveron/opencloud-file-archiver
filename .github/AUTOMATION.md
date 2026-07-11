# Repository Automation Setup

The workflows are safe-by-default but require repository configuration before enabling automatic
maintenance and release.

## Required secret: `RENOVATE_TOKEN`

The single weekly workflow self-hosts Renovate. `GITHUB_TOKEN` must not be substituted: pull
requests created with it do not reliably trigger normal PR/push workflows.

Prefer a dedicated GitHub App installation token or narrowly scoped bot token. It needs repository
contents and pull requests read/write, issues read/write for the dependency dashboard, commit
status/check access, and Dependabot alert read access. Workflow write access is needed only if
Renovate is expected to update GitHub Actions references. Store the token only as the repository
Actions secret `RENOVATE_TOKEN`.

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
and compatibility-lock updates; major updates still cannot automerge.

Never change PR validation to `pull_request_target`. It intentionally has read-only contents access,
does not persist checkout credentials, and receives no repository secrets.

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
tag. It updates one rolling blocker issue instead of creating weekly duplicates. When main changed,
it invokes the full acceptance workflow and creates the next patch release.

A merged PR labeled `security:high` or `security:critical` invokes the same workflow immediately.
Maintainers can also dispatch `release.yml` with `release_kind=urgent`. Urgency never skips full
acceptance.

Configure a `release` GitHub Environment without required reviewers so weekly and urgent releases
remain unattended; do not place build credentials in that environment. Candidate GHCR images are
produced with the workflow token and addressed by digest.

## Artifact identity

The frontend ZIP is built once, uploaded between jobs, accepted, then attached unchanged to the
GitHub Release. The backend is built once as an amd64/arm64 candidate manifest. Acceptance uses its
digest; publication adds `X.Y.Z` and `latest` tags to that same digest with `imagetools create` and
does not rebuild it.
