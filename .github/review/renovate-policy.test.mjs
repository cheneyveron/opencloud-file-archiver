import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const config = JSON.parse(
  await readFile(new URL('../../renovate.json', import.meta.url), 'utf8'),
)

function rule(description) {
  const match = config.packageRules.find((candidate) => candidate.description === description)
  assert.ok(match, `missing Renovate rule: ${description}`)
  return match
}

test('ordinary updates explicitly match missing vulnerability metadata and reject breaking changes', () => {
  const ordinary = rule('Accumulate all ordinary non-breaking updates in one weekly release PR')

  assert.deepEqual(ordinary.matchJsonata, [
    '$not(isVulnerabilityAlert = true) and isBreaking != true',
  ])
  assert.equal(ordinary.automerge, true)
  assert.ok(ordinary.labels.includes('release:weekly'))
})

test('every workflow action update receives the trusted automation marker', () => {
  const marker = rule(
    'Every Renovate workflow action update receives the trusted automation marker',
  )
  assert.deepEqual(marker.matchManagers, ['github-actions'])
  assert.deepEqual(marker.addLabels, ['review:automation'])
  assert.equal(marker.matchJsonata, undefined)
})

test('ordinary workflow action updates use the non-breaking weekly guard', () => {
  const actions = rule(
    'Non-breaking workflow action updates join weekly maintenance after full acceptance',
  )

  assert.deepEqual(actions.matchJsonata, [
    '$not(isVulnerabilityAlert = true) and isBreaking != true',
  ])
  assert.equal(actions.automerge, true)
  assert.ok(actions.labels.includes('release:weekly'))
  assert.equal(actions.groupSlug, 'runtime-build-toolchain-compatibility')
})

test('breaking classifications default to roadmap review regardless of update type', () => {
  const breaking = rule(
    'Every update Renovate classifies as breaking requires roadmap analysis and never automerges',
  )

  assert.deepEqual(breaking.matchJsonata, ['isBreaking = true'])
  assert.equal(breaking.matchUpdateTypes, undefined)
  assert.equal(breaking.groupName, null)
  assert.equal(breaking.automerge, false)
  assert.ok(breaking.labels.includes('roadmap:required'))
})

test('breaking High and Critical security updates are isolated and gated for urgent automerge', () => {
  for (const severity of ['High', 'Critical']) {
    const breaking = rule(
      `Breaking ${severity} security fixes are isolated and may merge only after every required gate`,
    )

    assert.equal(breaking.automerge, true)
    assert.equal(breaking.automergeType, 'pr')
    assert.equal(breaking.groupName, null)
    assert.ok(!breaking.labels.includes('roadmap:required'))
    assert.ok(breaking.labels.includes(`security:${severity.toLowerCase()}`))
    assert.ok(breaking.prBodyNotes.some((note) => note.startsWith(`Security impact: ${severity}`)))
    assert.ok(breaking.prBodyNotes.some((note) => /GHSA\/CVE/.test(note)))
    assert.equal(
      breaking.matchJsonata[0],
      `isBreaking = true and isVulnerabilityAlert = true and vulnerabilitySeverity = '${severity.toUpperCase()}'`,
    )
  }
})

test('vulnerability alerts are explicitly ungrouped before severity routing', () => {
  assert.equal(config.vulnerabilityAlerts.groupName, null)
  assert.equal(config.vulnerabilityAlerts.labels, undefined)
})

test('runtime and build toolchains are isolated from application dependencies', () => {
  const toolchains = rule(
    'Keep runtime and build toolchains out of the application dependency batch',
  )
  for (const dependency of ['alpine', 'caddy', 'golang', 'node', 'pnpm']) {
    assert.ok(toolchains.matchPackageNames.includes(dependency))
  }
  assert.equal(toolchains.groupSlug, 'runtime-build-toolchain-compatibility')
})

test('Go compiler releases bypass stability delay but retain the normal gates', () => {
  const compiler = rule(
    'Go compiler releases bypass stability delay because reachable standard-library fixes are release blockers',
  )
  assert.deepEqual(compiler.matchDatasources, ['docker'])
  assert.deepEqual(compiler.matchPackageNames, ['golang'])
  assert.equal(compiler.minimumReleaseAge, '0 days')
  assert.equal(compiler.automerge, undefined)
})

test('prerelease baselines fail closed into roadmap review', () => {
  const prerelease = rule(
    'Updates from a prerelease baseline require explicit roadmap compatibility review',
  )
  assert.equal(prerelease.matchCurrentVersion, '/-/')
  assert.equal(prerelease.groupName, null)
  assert.equal(prerelease.automerge, false)
  assert.ok(prerelease.labels.includes('roadmap:required'))
})

test('the Go scalar uses the same Docker lookup as its image references', () => {
  const scalar = config.customManagers.find(
    (manager) => manager.currentValueTemplate === '{{{goVersion}}}-alpine',
  )
  assert.ok(scalar)
  assert.equal(scalar.currentValueTemplate, '{{{goVersion}}}-alpine')
  assert.match(scalar.matchStrings[0], /datasource=\(\?<datasource>docker\)/)
  assert.match(scalar.autoReplaceStringTemplate, /go: "\{\{\{newVersion\}\}\}"/)

  const genericScalar = config.customManagers.find((manager) =>
    manager.matchStrings?.some((pattern) => pattern.includes('(?:node|pnpm)')),
  )
  assert.ok(genericScalar)
  assert.ok(!genericScalar.matchStrings[0].includes('golang-version'))
})
