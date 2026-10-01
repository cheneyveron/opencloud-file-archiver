import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allGoModuleNames,
  deprecatedPnpmPackages,
  directGoModuleNames,
  isAbandonedRenovatePullRequest,
  isAutomatedDependencyPullRequest,
  isPendingReleasePullRequest,
  lockedDirectPnpmVersions,
  pnpmUpdateSummary,
  requiredCheckSummary,
  replacementLeadLabel,
  safeReportText,
  suggestedReplacementNames,
} from '../maintenance/weekly-report-lib.mjs'

test('pnpm outdated uses wanted when current is absent and omits current packages', () => {
  const result = pnpmUpdateSummary({
    current: { wanted: '1.2.3', latest: '1.2.3' },
    stale: { wanted: '2.0.0', latest: '2.1.0' },
    fallback: { current: '3.0.0', latest: '3.0.1' },
  })

  assert.deepEqual(result, {
    failures: [],
    updates: ['stale: 2.0.0 → 2.1.0', 'fallback: 3.0.0 → 3.0.1'],
  })
})

test('pnpm outdated reports incomplete registry records instead of inventing versions', () => {
  assert.deepEqual(pnpmUpdateSummary({ broken: { latest: '1.0.0' } }), {
    failures: ['broken: pnpm omitted the locked or latest version'],
    updates: [],
  })
})

test('PAT-authored Renovate branches retain their automated dependency identity', () => {
  assert.equal(isAutomatedDependencyPullRequest({
    authorLogin: 'cheneyveron',
    authorType: 'User',
    headRef: 'renovate/runtime-build-toolchain-compatibility',
  }), true)
  assert.equal(isAutomatedDependencyPullRequest({
    authorLogin: 'cheneyveron',
    authorType: 'User',
    headRef: 'fix/manual-compatibility',
  }), false)
})

test('pnpm lockfile deprecations include scoped and unscoped transitive packages', () => {
  const lockfile = `lockfileVersion: '9.0'
packages:
  glob@10.5.0:
    deprecated: Use glob 13 instead
  '@scope/old@1.0.0':
    deprecated: Moved to @scope/new
snapshots:
  glob@10.5.0: {}
`
  assert.deepEqual(deprecatedPnpmPackages(lockfile), [
    { dependency: 'glob', version: '10.5.0', note: 'Use glob 13 instead' },
    { dependency: '@scope/old', version: '1.0.0', note: 'Moved to @scope/new' },
  ])
})

test('direct npm versions come from the clean lockfile importer without node_modules', () => {
  const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@scope/tool':
        specifier: ^1.0.0
        version: 1.2.3(peer@4.0.0)
      plain:
        specifier: ^2.0.0
        version: 2.1.0
packages:
  '@scope/tool@1.2.3': {}
`
  assert.deepEqual([...lockedDirectPnpmVersions(lockfile)], [
    ['@scope/tool', '1.2.3'],
    ['plain', '2.1.0'],
  ])
})

test('direct Go reporting excludes indirect modules', () => {
  const goMod = `module example.test/project

go 1.25.0

require (
  example.test/direct v1.2.3
  example.test/indirect v2.0.0 // indirect
)
`
  assert.deepEqual(directGoModuleNames(goMod), ['example.test/direct'])
  assert.deepEqual(allGoModuleNames(goMod), ['example.test/direct', 'example.test/indirect'])
})

test('replacement hints are extracted from deprecation prose and GitHub links', () => {
  assert.deepEqual(
    suggestedReplacementNames(
      'Deprecated: migrate to `@scope/new-lib` or see https://github.com/example/new-repo.git',
      '@scope/old-lib',
    ),
    ['@scope/new-lib', 'example/new-repo'],
  )
  assert.deepEqual(
    suggestedReplacementNames("Use your platform's native DOMException instead", 'node-domexception'),
    [],
  )
  assert.equal(replacementLeadLabel('registry search lead'), 'Untrusted lead')
  assert.equal(replacementLeadLabel('explicit deprecation hint'), 'Verified candidate')
})

test('external lifecycle prose cannot create mentions or Markdown links', () => {
  const value = safeReportText('@everyone [click](javascript:alert(1))\nnext')
  assert.ok(!value.includes('@everyone'))
  assert.ok(!value.includes('[click]('))
  assert.ok(!value.includes('\n'))
})

test('PR reporting uses the newest result for duplicate required checks', () => {
  const summary = requiredCheckSummary([
    {
      name: 'Automated review / policy',
      conclusion: 'CANCELLED',
      startedAt: '2026-07-11T00:00:00Z',
    },
    {
      name: 'Automated review / policy',
      conclusion: 'SUCCESS',
      startedAt: '2026-07-11T00:01:00Z',
    },
    {
      name: 'Full acceptance / latest OpenCloud stable',
      conclusion: 'FAILURE',
      startedAt: '2026-07-11T00:02:00Z',
    },
  ])
  assert.match(summary, /Automated review \/ policy: success/)
  assert.match(summary, /Full acceptance \/ latest OpenCloud stable: failure/)
  assert.match(summary, /CodeQL \/ go: missing/)
  assert.match(summary, /CodeQL \/ javascript-typescript: missing/)
})

test('a newer queued Actions run supersedes an older completed required check', () => {
  const summary = requiredCheckSummary([
    {
      name: 'CodeQL / go',
      conclusion: 'SUCCESS',
      startedAt: '2026-07-11T00:05:00Z',
      detailsUrl: 'https://github.com/example/repo/actions/runs/100/job/1',
    },
    {
      name: 'CodeQL / go',
      status: 'QUEUED',
      startedAt: null,
      completedAt: null,
      detailsUrl: 'https://github.com/example/repo/actions/runs/101/job/2',
    },
  ])
  assert.match(summary, /CodeQL \/ go: queued/)
})

test('a queued rerun job supersedes a completed job from the same Actions run', () => {
  const summary = requiredCheckSummary([
    {
      name: 'Full acceptance / latest OpenCloud stable',
      conclusion: 'FAILURE',
      startedAt: '2026-07-11T00:05:00Z',
      detailsUrl: 'https://github.com/example/repo/actions/runs/101/job/2001',
    },
    {
      name: 'Full acceptance / latest OpenCloud stable',
      status: 'QUEUED',
      startedAt: null,
      completedAt: null,
      detailsUrl: 'https://github.com/example/repo/actions/runs/101/job/2002',
    },
  ])
  assert.match(summary, /Full acceptance \/ latest OpenCloud stable: queued/)
})

test('only Renovate branches with the canonical abandoned suffix are ignored', () => {
  assert.equal(isAbandonedRenovatePullRequest({
    headRefName: 'renovate/old-update',
    title: 'Update old dependency - abandoned',
    labels: [{ name: 'dependencies' }],
  }), true)
  assert.equal(isAbandonedRenovatePullRequest({
    headRefName: 'feature/not-renovate',
    title: 'Update old dependency - abandoned',
    labels: [{ name: 'dependencies' }],
  }), false)
  assert.equal(isAbandonedRenovatePullRequest({
    headRefName: 'renovate/live-update',
    title: 'Update live dependency',
    labels: [{ name: 'dependencies' }],
  }), false)
  assert.equal(isAbandonedRenovatePullRequest({
    headRefName: 'renovate/untrusted-suffix',
    title: 'Update old dependency - abandoned',
    labels: [],
  }), false)
})

test('an abandoned Renovate PR cannot remain a release blocker through stale labels', () => {
  assert.equal(isPendingReleasePullRequest({
    headRefName: 'renovate/old-update',
    title: 'Update old dependency - abandoned',
    labels: [{ name: 'dependencies' }, { name: 'release:weekly' }],
  }), false)
  assert.equal(isPendingReleasePullRequest({
    headRefName: 'renovate/live-update',
    title: 'Update live dependency',
    labels: [{ name: 'dependencies' }, { name: 'release:weekly' }],
  }), true)
})

test('pnpm 12 reads app versions after the separate package-manager lock document', () => {
  const lockfile = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.6.0
        version: 12.6.0
packages:
  pnpm@12.6.0: {}
snapshots:
  pnpm@12.6.0: {}
---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@scope/tool':
        specifier: ^8.0.0
        version: 8.0.0(peer@4.0.0)
    optionalDependencies:
      optional:
        specifier: ^2.0.0
        version: 2.1.0
  packages/other:
    dependencies:
      '@scope/tool':
        specifier: ^9.0.0
        version: 9.0.0
packages:
  '@scope/tool@8.0.0':
    deprecated: Use the replacement
snapshots:
  '@scope/tool@8.0.0': {}
`
  assert.deepEqual([...lockedDirectPnpmVersions(lockfile)], [
    ['@scope/tool', '8.0.0'], ['optional', '2.1.0'],
  ])
  assert.deepEqual(deprecatedPnpmPackages(lockfile), [
    { dependency: '@scope/tool', version: '8.0.0', note: 'Use the replacement' },
  ])
})

test('release reporting resolves every declared dependency from the tracked lockfile', async () => {
  const { readFile } = await import('node:fs/promises')
  const root = new URL('../../web-app-file-archiver/', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const versions = lockedDirectPnpmVersions(await readFile(new URL('pnpm-lock.yaml', root), 'utf8'))
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
  assert.deepEqual([...versions.keys()].sort(), Object.keys(declared).sort())
  for (const [name, version] of versions) assert.match(version, /^\d+\.\d+\.\d+$/, name)
})
