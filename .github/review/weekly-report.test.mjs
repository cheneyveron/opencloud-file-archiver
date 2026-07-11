import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allGoModuleNames,
  deprecatedPnpmPackages,
  directGoModuleNames,
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
      name: 'Full acceptance / locked OpenCloud stable',
      conclusion: 'FAILURE',
      startedAt: '2026-07-11T00:02:00Z',
    },
  ])
  assert.match(summary, /Automated review \/ policy: success/)
  assert.match(summary, /Full acceptance \/ locked OpenCloud stable: failure/)
})
