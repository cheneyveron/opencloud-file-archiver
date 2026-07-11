import assert from 'node:assert/strict'
import test from 'node:test'

import {
  makeNormalizationPlan,
  normalizeDependabot,
  parseDependabotMetadata,
  validateWorkflowRun,
  versionAtLeast
} from './dependabot-normalize.mjs'

const message = ({ updateType = 'version-update:semver-patch', to = '1.2.4' } = {}) => `Bumps [example](https://example.test) from 1.2.3 to ${to}.

---
updated-dependencies:
- dependency-name: example
  dependency-type: direct:production
  update-type: ${updateType}
...

Signed-off-by: dependabot[bot] <support@github.com>`

const alert = (severity, patched = '1.2.4') => ({
  number: 7,
  dependency: {
    package: { name: 'example' },
    manifest_path: 'web-app-file-archiver/pnpm-lock.yaml'
  },
  security_advisory: {
    ghsa_id: 'GHSA-aaaa-bbbb-cccc',
    cve_id: 'CVE-2026-12345',
    severity
  },
  security_vulnerability: {
    package: { name: 'example' },
    severity,
    first_patched_version: { identifier: patched }
  }
})

const plan = ({ severity, updateType, to, files = ['web-app-file-archiver/pnpm-lock.yaml'] }) => makeNormalizationPlan({
  dependencies: parseDependabotMetadata(message({ updateType, to })),
  alerts: severity ? [alert(severity)] : [],
  changedFiles: files,
  ecosystem: 'npm_and_yarn',
  headSha: 'a'.repeat(40),
  existingBody: 'Native Dependabot notes.'
})

test('parses signed Dependabot metadata and versions', () => {
  assert.deepEqual(parseDependabotMetadata(message()), [{
    dependencyName: 'example',
    dependencyType: 'direct:production',
    updateType: 'version-update:semver-patch',
    previousVersion: '1.2.3',
    newVersion: '1.2.4'
  }])
})

test('compares stable and prerelease versions conservatively', () => {
  assert.equal(versionAtLeast('v1.3.0', '1.2.4'), true)
  assert.equal(versionAtLeast('1.2.3', '1.2.4'), false)
  assert.equal(versionAtLeast('1.2.4', '1.2.4-beta.1'), true)
  assert.equal(versionAtLeast('workspace:*', '1.2.4'), false)
})

test('High non-major update is urgent and can auto-merge', () => {
  const result = plan({ severity: 'high' })
  assert.equal(result.enableAutoMerge, true)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'security:high'])
  assert.match(result.body, /Security impact: High\b/)
  assert.match(result.body, /github\.com\/advisories\/GHSA-AAAA-BBBB-CCCC/)
  assert.match(result.body, /Roadmap item: RM-001/)
  assert.match(result.body, /Validation: Automated review/)
})

test('Medium non-major update joins weekly release and can auto-merge', () => {
  const result = plan({ severity: 'medium' })
  assert.equal(result.enableAutoMerge, true)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'release:weekly', 'security:medium'])
})

test('Go module security updates recognize the native go_modules branch ecosystem', () => {
  const goAlert = alert('high')
  goAlert.dependency.manifest_path = 'file-archiver-service/go.mod'
  const result = makeNormalizationPlan({
    dependencies: parseDependabotMetadata(message()),
    alerts: [goAlert],
    changedFiles: ['file-archiver-service/go.mod', 'file-archiver-service/go.sum'],
    ecosystem: 'go_modules',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.enableAutoMerge, true)
  assert.equal(result.severity, 'high')
})

test('Critical major update remains urgent but never auto-merges', () => {
  const result = plan({ severity: 'critical', updateType: 'version-update:semver-major', to: '2.0.0' })
  assert.equal(result.enableAutoMerge, false)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'roadmap:required', 'security:critical'])
  assert.match(result.body, /major; manual roadmap decision required/)
})

test('unmatched alert is quarantined instead of guessing a severity', () => {
  const result = plan({})
  assert.equal(result.enableAutoMerge, false)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'roadmap:required', 'security:triage'])
  assert.match(result.body, /Security impact: Unknown/)
})

test('automation changes receive the trusted automation label', () => {
  const result = plan({ severity: 'low', files: ['.github/workflows/example.yml', 'web-app-file-archiver/pnpm-lock.yaml'] })
  assert.equal(result.enableAutoMerge, false)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'release:weekly', 'review:automation', 'roadmap:required', 'security:low'])
})

test('unexpected dependency files disable auto-merge', () => {
  const result = plan({ severity: 'high', files: ['README.md', 'web-app-file-archiver/pnpm-lock.yaml'] })
  assert.equal(result.enableAutoMerge, false)
  assert.ok(result.labels.includes('roadmap:required'))
})

test('an update that was already patched does not claim the alert', () => {
  const dependencies = parseDependabotMetadata(message())
  dependencies[0].previousVersion = '1.2.4'
  const result = makeNormalizationPlan({
    dependencies,
    alerts: [alert('critical')],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.severity, '')
  assert.equal(result.enableAutoMerge, false)
})

test('an incomparable target version cannot satisfy a patched version', () => {
  const dependencies = parseDependabotMetadata(message())
  dependencies[0].newVersion = 'workspace:*'
  const result = makeNormalizationPlan({
    dependencies,
    alerts: [alert('high')],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.severity, '')
  assert.equal(result.enableAutoMerge, false)
})

test('workflow run validation quarantines reruns by another actor', () => {
  const event = {
    action: 'completed',
    repository: { full_name: 'owner/repo' },
    workflow_run: {
      name: 'Dependabot intake',
      event: 'pull_request',
      conclusion: 'success',
      actor: { login: 'dependabot[bot]' },
      triggering_actor: { login: 'maintainer' },
      head_repository: { full_name: 'owner/repo' },
      pull_requests: [{ number: 9 }]
    }
  }
  assert.deepEqual(validateWorkflowRun({ event, repository: 'owner/repo' }), {
    botTriggered: false,
    pullNumber: 9
  })
})

test('non-bot synchronize only disables auto-merge and performs no metadata writes', async () => {
  const sha = 'b'.repeat(40)
  const event = {
    action: 'completed',
    repository: { full_name: 'owner/repo', default_branch: 'main' },
    workflow_run: {
      workflow_id: 42,
      name: 'Dependabot intake',
      event: 'pull_request',
      conclusion: 'success',
      actor: { login: 'maintainer' },
      triggering_actor: { login: 'maintainer' },
      head_repository: { full_name: 'owner/repo' },
      head_sha: sha,
      pull_requests: [{ number: 9 }]
    }
  }
  const pullRequest = {
    number: 9,
    node_id: 'PR_node',
    state: 'open',
    user: { login: 'dependabot[bot]', type: 'Bot' },
    head: { ref: 'dependabot/npm_and_yarn/example-1.2.4', sha, repo: { full_name: 'owner/repo' } },
    base: { ref: 'main', repo: { full_name: 'owner/repo' } },
    auto_merge: { enabled_by: { login: 'automation-bot' } },
    labels: [{ name: 'security:high' }]
  }
  const writes = []
  const api = {
    async request (path, options = {}) {
      if (options.method && options.method !== 'GET') writes.push({ path, options })
      if (path.endsWith('/actions/workflows/42')) {
        return { data: { name: 'Dependabot intake', path: '.github/workflows/dependabot-intake.yml' } }
      }
      if (path.endsWith('/pulls/9')) return { data: structuredClone(pullRequest) }
      throw new Error(`Unexpected request: ${path}`)
    },
    async graphql (query) {
      writes.push({ graphql: query })
      return { disablePullRequestAutoMerge: { pullRequest: { number: 9 } } }
    }
  }

  const result = await normalizeDependabot({ event, repository: 'owner/repo', api })
  assert.equal(result.quarantined, true)
  assert.equal(writes.length, 1)
  assert.match(writes[0].graphql, /disablePullRequestAutoMerge/)
})
