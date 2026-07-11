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

const groupedMessage = (dependencies) => `${dependencies.map(({ name, previousVersion, newVersion }) =>
  `Updates \`${name}\` from ${previousVersion} to ${newVersion}`
).join('\n')}

---
updated-dependencies:
${dependencies.map(({ name, newVersion, updateType }) => `- dependency-name: ${name}
  dependency-type: direct:production
  update-type: ${updateType}
  dependency-version: ${newVersion}`).join('\n')}
...

Signed-off-by: dependabot[bot] <support@github.com>`

const dependencyAlert = ({ name, severity, patchedVersion, number }) => {
  const result = alert(severity, patchedVersion)
  result.number = number
  result.dependency.package.name = name
  result.security_vulnerability.package.name = name
  return result
}

const normalizationHarness = ({
  dependencies,
  alerts,
  autoMerge = false,
  changedFile = 'web-app-file-archiver/pnpm-lock.yaml',
  ecosystem = 'npm_and_yarn',
  existingLabels = [],
  failAt = ''
}) => {
  const repository = 'owner/repo'
  const pullNumber = 9
  const sha = 'c'.repeat(40)
  const state = {
    body: 'Native Dependabot notes.',
    labels: existingLabels.map((name) => ({ name })),
    auto_merge: autoMerge ? { enabled_by: { login: 'automation-bot' } } : null
  }
  const pullRequest = () => ({
    number: pullNumber,
    node_id: 'PR_node',
    state: 'open',
    user: { login: 'dependabot[bot]', type: 'Bot' },
    head: {
      ref: `dependabot/${ecosystem}/grouped-security-update`,
      sha,
      repo: { full_name: repository }
    },
    base: { ref: 'main', repo: { full_name: repository } },
    body: state.body,
    labels: state.labels,
    auto_merge: state.auto_merge,
    commits: 1,
    changed_files: 1
  })
  const event = {
    action: 'completed',
    repository: { full_name: repository, default_branch: 'main' },
    workflow_run: {
      workflow_id: 42,
      name: 'Dependabot intake',
      event: 'pull_request',
      conclusion: 'success',
      actor: { login: 'dependabot[bot]' },
      triggering_actor: { login: 'dependabot[bot]' },
      head_repository: { full_name: repository },
      head_sha: sha,
      pull_requests: [{ number: pullNumber }]
    }
  }
  const writes = []
  const api = {
    async request (path, options = {}) {
      const method = options.method || 'GET'
      if (method !== 'GET') writes.push({ kind: 'request', path, method, body: options.body })
      if (method === 'GET' && path.endsWith('/actions/workflows/42')) {
        return { data: { name: 'Dependabot intake', path: '.github/workflows/dependabot-intake.yml' } }
      }
      if (method === 'GET' && path === `/repos/${repository}/pulls/${pullNumber}`) {
        return { data: structuredClone(pullRequest()) }
      }
      if (method === 'GET' && path.startsWith(`/repos/${repository}/pulls/${pullNumber}/commits?`)) {
        return {
          data: [{
            sha,
            author: { login: 'dependabot[bot]' },
            commit: {
              message: groupedMessage(dependencies),
              verification: { verified: true }
            }
          }]
        }
      }
      if (method === 'GET' && path.startsWith(`/repos/${repository}/pulls/${pullNumber}/files?`)) {
        return { data: [{ filename: changedFile }] }
      }
      if (method === 'GET' && path.startsWith(`/repos/${repository}/dependabot/alerts?state=open&`)) {
        return { data: structuredClone(alerts) }
      }
      if (method === 'GET' && path.startsWith(`/repos/${repository}/labels/`)) {
        return { status: 200, data: {} }
      }
      if (method === 'PATCH' && path === `/repos/${repository}/pulls/${pullNumber}`) {
        if (failAt === 'patch') throw new Error('injected PATCH failure')
        state.body = options.body.body
        return { data: structuredClone(pullRequest()) }
      }
      if (method === 'PUT' && path === `/repos/${repository}/issues/${pullNumber}/labels`) {
        if (failAt === 'labels') throw new Error('injected labels failure')
        state.labels = options.body.labels.map((name) => ({ name }))
        return { data: structuredClone(state.labels) }
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    },
    async graphql (query, variables) {
      writes.push({ kind: 'graphql', query, variables })
      if (query.includes('enablePullRequestAutoMerge')) {
        if (failAt === 'enable') throw new Error('injected enable failure')
        state.auto_merge = { enabled_by: { login: 'automation-bot' } }
        return { enablePullRequestAutoMerge: { pullRequest: { number: pullNumber } } }
      }
      if (query.includes('disablePullRequestAutoMerge')) {
        if (failAt === 'disable') throw new Error('injected disable failure')
        state.auto_merge = null
        return { disablePullRequestAutoMerge: { pullRequest: { number: pullNumber } } }
      }
      throw new Error('Unexpected GraphQL mutation')
    }
  }

  return { api, event, pullNumber, repository, sha, state, writes }
}

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
  assert.match(result.body, /Validation: Automated review.*both CodeQL analyses/)
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

test('Critical major update auto-merges only after its alert and full gates match', () => {
  const result = plan({ severity: 'critical', updateType: 'version-update:semver-major', to: '2.0.0' })
  assert.equal(result.enableAutoMerge, true)
  assert.deepEqual(result.labels, ['dependabot:normalized', 'dependencies', 'security:critical'])
  assert.match(result.body, /major; every major dependency is covered by a High\/Critical alert/)
})

test('one urgent alert cannot authorize unmatched minor or major dependencies in a grouped PR', () => {
  for (const updateType of ['version-update:semver-minor', 'version-update:semver-major']) {
    const dependencies = [
      {
        dependencyName: 'example',
        updateType: 'version-update:semver-patch',
        previousVersion: '1.2.3',
        newVersion: '1.2.4'
      },
      {
        dependencyName: 'unrelated',
        updateType,
        previousVersion: '1.0.0',
        newVersion: updateType.endsWith('major') ? '2.0.0' : '1.1.0'
      }
    ]
    const result = makeNormalizationPlan({
      dependencies,
      alerts: [alert('high')],
      changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
      ecosystem: 'npm_and_yarn',
      headSha: 'a'.repeat(40)
    })
    assert.equal(result.allDependenciesMatched, false)
    assert.equal(result.everyMajorIsUrgent, !updateType.endsWith('major'))
    assert.equal(result.enableAutoMerge, false)
    assert.ok(result.labels.includes('roadmap:required'))
    assert.match(result.body, /at least one signed dependency is not covered/)
  }
})

test('every major dependency in a grouped PR needs its own High or Critical alert', () => {
  const dependencies = [
    {
      dependencyName: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      dependencyName: 'second',
      updateType: 'version-update:semver-major',
      previousVersion: '3.0.0',
      newVersion: '4.0.0'
    }
  ]
  const high = alert('high', '2.0.0')
  const medium = alert('medium', '4.0.0')
  medium.number = 8
  medium.dependency.package.name = 'second'
  medium.security_vulnerability.package.name = 'second'

  const blocked = makeNormalizationPlan({
    dependencies,
    alerts: [high, medium],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(blocked.allDependenciesMatched, true)
  assert.equal(blocked.everyMajorIsUrgent, false)
  assert.equal(blocked.enableAutoMerge, false)
  assert.ok(blocked.labels.includes('roadmap:required'))

  medium.security_advisory.severity = 'critical'
  medium.security_vulnerability.severity = 'critical'
  const eligible = makeNormalizationPlan({
    dependencies,
    alerts: [high, medium],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(eligible.everyMajorIsUrgent, true)
  assert.equal(eligible.enableAutoMerge, true)
  assert.ok(!eligible.labels.includes('roadmap:required'))
})

test('matched non-major advisories may accompany a separately covered urgent major', () => {
  const dependencies = [
    {
      dependencyName: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      dependencyName: 'second',
      updateType: 'version-update:semver-patch',
      previousVersion: '3.0.0',
      newVersion: '3.0.1'
    }
  ]
  const high = alert('high', '2.0.0')
  const medium = alert('medium', '3.0.1')
  medium.number = 8
  medium.dependency.package.name = 'second'
  medium.security_vulnerability.package.name = 'second'
  const result = makeNormalizationPlan({
    dependencies,
    alerts: [high, medium],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.allDependenciesMatched, true)
  assert.equal(result.everyMajorIsUrgent, true)
  assert.equal(result.enableAutoMerge, true)
})

test('duplicate dependency metadata needs independent alert coverage', () => {
  const dependencies = [
    {
      dependencyName: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      dependencyName: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    }
  ]
  const result = makeNormalizationPlan({
    dependencies,
    alerts: [alert('high', '2.0.0')],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.allDependenciesMatched, false)
  assert.equal(result.enableAutoMerge, false)
  assert.ok(result.labels.includes('roadmap:required'))
})

test('High development dependency major follows the explicit build-chain urgent policy', () => {
  const developmentAlert = alert('high', '2.0.0')
  developmentAlert.dependency.scope = 'development'
  const result = makeNormalizationPlan({
    dependencies: [{
      dependencyName: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    }],
    alerts: [developmentAlert],
    changedFiles: ['web-app-file-archiver/pnpm-lock.yaml'],
    ecosystem: 'npm_and_yarn',
    headSha: 'a'.repeat(40)
  })
  assert.equal(result.enableAutoMerge, true)
  assert.doesNotMatch(result.body, /runtime/i)
})

test('verified High and Critical workflow action updates can pass the automation boundary', () => {
  const workflow = '.github/workflows/fixture.yml'
  for (const severity of ['high', 'critical']) {
    for (const updateType of ['version-update:semver-patch', 'version-update:semver-major']) {
      const newVersion = updateType.endsWith('major') ? '2.0.0' : '1.2.4'
      const actionAlert = alert(severity, newVersion)
      actionAlert.dependency.manifest_path = workflow
      const result = makeNormalizationPlan({
        dependencies: [{
          dependencyName: 'example',
          updateType,
          previousVersion: '1.2.3',
          newVersion
        }],
        alerts: [actionAlert],
        changedFiles: [workflow],
        ecosystem: 'github_actions',
        headSha: 'a'.repeat(40)
      })
      assert.equal(result.verifiedWorkflowActionUpdate, true)
      assert.equal(result.enableAutoMerge, true)
      assert.ok(result.labels.includes('review:automation'))
      assert.ok(result.labels.includes(`security:${severity}`))
      assert.ok(!result.labels.includes('roadmap:required'))
    }
  }
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

test('normalizer API disables an existing auto-merge for grouped High plus unmatched dependency', async () => {
  const dependencies = [
    {
      name: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      name: 'unrelated',
      updateType: 'version-update:semver-minor',
      previousVersion: '3.0.0',
      newVersion: '3.1.0'
    }
  ]
  const harness = normalizationHarness({
    dependencies,
    alerts: [dependencyAlert({
      name: 'example',
      severity: 'high',
      patchedVersion: '2.0.0',
      number: 7
    })],
    autoMerge: true,
    existingLabels: ['custom:keep', 'security:high']
  })

  const result = await normalizeDependabot({
    event: harness.event,
    repository: harness.repository,
    api: harness.api
  })

  assert.equal(result.enableAutoMerge, false)
  assert.equal(result.allDependenciesMatched, false)
  const graphqlWrites = harness.writes.filter(({ kind }) => kind === 'graphql')
  assert.match(harness.writes[0].query, /disablePullRequestAutoMerge/)
  assert.equal(graphqlWrites.filter(({ query }) => query.includes('enablePullRequestAutoMerge')).length, 0)
  assert.equal(graphqlWrites.filter(({ query }) => query.includes('disablePullRequestAutoMerge')).length, 1)
  const labelWrites = harness.writes.filter(({ method, path }) =>
    method === 'PUT' && path === `/repos/${harness.repository}/issues/${harness.pullNumber}/labels`
  )
  assert.equal(labelWrites.length, 1)
  assert.ok(labelWrites[0].body.labels.includes('roadmap:required'))
  assert.ok(labelWrites[0].body.labels.includes('custom:keep'))
  assert.equal(harness.state.auto_merge, null)
})

test('normalizer API enables fully covered urgent majors with current SHA and no roadmap label', async () => {
  const dependencies = [
    {
      name: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      name: 'second',
      updateType: 'version-update:semver-major',
      previousVersion: '3.0.0',
      newVersion: '4.0.0'
    }
  ]
  const harness = normalizationHarness({
    dependencies,
    alerts: [
      dependencyAlert({
        name: 'example',
        severity: 'high',
        patchedVersion: '2.0.0',
        number: 7
      }),
      dependencyAlert({
        name: 'second',
        severity: 'critical',
        patchedVersion: '4.0.0',
        number: 8
      })
    ],
    existingLabels: ['roadmap:required']
  })

  const result = await normalizeDependabot({
    event: harness.event,
    repository: harness.repository,
    api: harness.api
  })

  assert.equal(result.enableAutoMerge, true)
  assert.equal(result.allDependenciesMatched, true)
  assert.equal(result.everyMajorIsUrgent, true)
  const graphqlWrites = harness.writes.filter(({ kind }) => kind === 'graphql')
  assert.equal(graphqlWrites.filter(({ query }) => query.includes('enablePullRequestAutoMerge')).length, 1)
  assert.equal(graphqlWrites.filter(({ query }) => query.includes('disablePullRequestAutoMerge')).length, 0)
  const labelWrites = harness.writes.filter(({ method, path }) =>
    method === 'PUT' && path === `/repos/${harness.repository}/issues/${harness.pullNumber}/labels`
  )
  assert.equal(labelWrites.length, 1)
  assert.ok(!labelWrites[0].body.labels.includes('roadmap:required'))
  assert.ok(labelWrites[0].body.labels.includes('security:critical'))
  const bodyWrites = harness.writes.filter(({ method, path }) =>
    method === 'PATCH' && path === `/repos/${harness.repository}/pulls/${harness.pullNumber}`
  )
  assert.equal(bodyWrites.length, 1)
  assert.match(bodyWrites[0].body.body, new RegExp(`^Normalized head SHA: ${harness.sha}$`, 'm'))
  assert.match(result.body, new RegExp(`^Normalized head SHA: ${harness.sha}$`, 'm'))
  assert.ok(harness.state.auto_merge)
})

test('normalizer API enables a verified High workflow action update after all metadata checks', async () => {
  const workflow = '.github/workflows/fixture.yml'
  const actionAlert = dependencyAlert({
    name: 'example',
    severity: 'high',
    patchedVersion: '2.0.0',
    number: 7
  })
  actionAlert.dependency.manifest_path = workflow
  const harness = normalizationHarness({
    dependencies: [{
      name: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    }],
    alerts: [actionAlert],
    changedFile: workflow,
    ecosystem: 'github_actions'
  })
  const result = await normalizeDependabot({
    event: harness.event,
    repository: harness.repository,
    api: harness.api
  })
  assert.equal(result.verifiedWorkflowActionUpdate, true)
  assert.equal(result.enableAutoMerge, true)
  assert.ok(result.labels.includes('review:automation'))
  assert.ok(result.labels.includes('security:high'))
  assert.ok(!result.labels.includes('roadmap:required'))
  assert.equal(
    harness.writes.filter(({ kind, query }) =>
      kind === 'graphql' && query.includes('enablePullRequestAutoMerge')
    ).length,
    1,
  )
})

test('normalizer failure injection never writes eligible metadata before revocation or leaves a new grant', async () => {
  const blockedDependencies = [
    {
      name: 'example',
      updateType: 'version-update:semver-major',
      previousVersion: '1.2.3',
      newVersion: '2.0.0'
    },
    {
      name: 'unmatched',
      updateType: 'version-update:semver-minor',
      previousVersion: '3.0.0',
      newVersion: '3.1.0'
    }
  ]
  const urgentAlert = dependencyAlert({
    name: 'example',
    severity: 'high',
    patchedVersion: '2.0.0',
    number: 7
  })

  for (const failAt of ['disable', 'patch', 'labels']) {
    const harness = normalizationHarness({
      dependencies: blockedDependencies,
      alerts: [urgentAlert],
      autoMerge: true,
      existingLabels: ['dependabot:normalized', 'security:high'],
      failAt
    })
    await assert.rejects(
      normalizeDependabot({ event: harness.event, repository: harness.repository, api: harness.api }),
      new RegExp(`injected ${failAt} failure`, 'i'),
    )
    assert.match(harness.writes[0].query, /disablePullRequestAutoMerge/)
    if (failAt === 'disable') {
      assert.ok(harness.state.auto_merge)
      assert.equal(harness.writes.some(({ method }) => method === 'PATCH' || method === 'PUT'), false)
    } else {
      assert.equal(harness.state.auto_merge, null)
    }
  }

  const eligibleHarness = normalizationHarness({
    dependencies: [blockedDependencies[0]],
    alerts: [urgentAlert],
    failAt: 'enable'
  })
  await assert.rejects(
    normalizeDependabot({
      event: eligibleHarness.event,
      repository: eligibleHarness.repository,
      api: eligibleHarness.api
    }),
    /injected enable failure/,
  )
  assert.equal(eligibleHarness.state.auto_merge, null)
  assert.equal(
    eligibleHarness.writes.filter(({ kind, query }) =>
      kind === 'graphql' && query.includes('enablePullRequestAutoMerge')
    ).length,
    1,
  )
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
