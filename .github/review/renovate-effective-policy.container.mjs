import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const renovateRoot = process.env.RENOVATE_PACKAGE_ROOT || '/usr/local/renovate'
const renovateModule = (relativePath) => pathToFileURL(join(renovateRoot, relativePath)).href
const { init } = await import(renovateModule('dist/logger/index.js'))
const { applyPackageRules } = await import(
  renovateModule('dist/util/package-rules/index.js')
)
const { extractPackageFile: extractRegex } = await import(
  renovateModule('dist/modules/manager/custom/regex/index.js')
)
const { extractPackageFile: extractDockerfile } = await import(
  renovateModule('dist/modules/manager/dockerfile/index.js')
)
const { compile } = await import(renovateModule('dist/util/template/index.js'))
await init()

const config = JSON.parse(await readFile('renovate.json', 'utf8'))

async function effectiveAlertConfig ({
  manager = 'npm',
  severity,
  updateType
}) {
  const packageName = 'security-fixture'
  const datasource = manager === 'github-actions' ? 'github-tags' : 'npm'
  const alertRule = {
    matchDatasources: [datasource],
    matchPackageNames: [packageName],
    matchCurrentVersion: '1.0.0',
    isVulnerabilityAlert: true,
    vulnerabilitySeverity: severity,
    force: { ...config.vulnerabilityAlerts }
  }
  return applyPackageRules({
    ...config,
    packageRules: [...config.packageRules, alertRule],
    manager,
    datasource,
    depName: packageName,
    packageName,
    packageFile: manager === 'github-actions'
      ? '.github/workflows/fixture.yml'
      : 'web-app-file-archiver/package.json',
    versioning: 'semver',
    currentValue: '1.0.0',
    currentVersion: '1.0.0',
    newVersion: updateType === 'major' ? '2.0.0' : '1.0.1',
    updateType,
    isBreaking: updateType === 'major',
    isVulnerabilityAlert: true,
    vulnerabilitySeverity: severity
  })
}

const combinedLabels = (result) => new Set([
  ...(result.labels || []),
  ...(result.addLabels || [])
])

for (const severity of ['HIGH', 'CRITICAL']) {
  for (const updateType of ['patch', 'major']) {
    test(`${severity} ${updateType} keeps urgent routing after the real alert force rule`, async () => {
      const result = await effectiveAlertConfig({ severity, updateType })
      const expectedLabel = `security:${severity.toLowerCase()}`
      assert.deepEqual(result.labels, ['dependencies', expectedLabel])
      assert.equal(result.groupName, null)
      assert.equal(result.automerge, true)
      assert.equal(result.automergeType, 'pr')
      assert.equal(result.minimumReleaseAge, '0 days')
      assert.ok(!combinedLabels(result).has('security:triage'))
      assert.ok(!combinedLabels(result).has('release:weekly'))
      assert.ok(!combinedLabels(result).has('roadmap:required'))
    })

    test(`${severity} ${updateType} GitHub Action retains automation review`, async () => {
      const result = await effectiveAlertConfig({ manager: 'github-actions', severity, updateType })
      assert.ok(combinedLabels(result).has(`security:${severity.toLowerCase()}`))
      assert.ok(combinedLabels(result).has('review:automation'))
      assert.equal(result.groupName, null)
      assert.equal(result.automerge, true)
    })
  }
}

test('a Medium major remains a manual roadmap decision', async () => {
  const result = await effectiveAlertConfig({ severity: 'MEDIUM', updateType: 'major' })
  assert.equal(result.automerge, false)
  assert.ok(combinedLabels(result).has('roadmap:required'))
  assert.ok(!combinedLabels(result).has('security:high'))
  assert.ok(!combinedLabels(result).has('security:critical'))
})

test('a prerelease baseline cannot enter the unattended application batch', async () => {
  const result = await applyPackageRules({
    ...config,
    manager: 'npm',
    datasource: 'npm',
    depName: 'vue3-gettext',
    packageName: 'vue3-gettext',
    packageFile: 'web-app-file-archiver/package.json',
    versioning: 'semver',
    currentValue: '4.0.0-beta.1',
    currentVersion: '4.0.0-beta.1',
    newVersion: '4.0.1',
    updateType: 'patch',
    isBreaking: false,
    isVulnerabilityAlert: false
  })
  assert.equal(result.groupName, null)
  assert.equal(result.automerge, false)
  assert.ok(combinedLabels(result).has('roadmap:required'))
  assert.ok(!combinedLabels(result).has('release:weekly'))
})

test('toolchain updates use a separate compatibility batch', async () => {
  for (const [depName, currentVersion, newVersion, packageFile] of [
    ['caddy', '2.10.2', '2.11.4', 'compatibility.lock.yaml'],
    ['alpine', '3.23', '3.24', 'file-archiver-service/Dockerfile'],
  ]) {
    const result = await applyPackageRules({
      ...config,
      manager: 'dockerfile',
      datasource: 'docker',
      depName,
      packageName: depName,
      packageFile,
      currentVersion,
      newVersion,
      updateType: 'minor',
      isBreaking: false,
      isVulnerabilityAlert: false
    })
    assert.equal(result.groupSlug, 'runtime-build-toolchain-compatibility')
    assert.equal(result.automerge, true)
    assert.ok(combinedLabels(result).has('release:weekly'))
  }
})

test('ordinary GitHub Actions updates join the reviewed toolchain batch', async () => {
  const result = await applyPackageRules({
    ...config,
    manager: 'github-actions',
    datasource: 'github-tags',
    depName: 'actions/checkout',
    packageName: 'actions/checkout',
    packageFile: '.github/workflows/pr-validation.yml',
    currentVersion: 'v6.0.1',
    newVersion: 'v6.0.2',
    updateType: 'patch',
    isBreaking: false,
    isVulnerabilityAlert: false
  })
  assert.equal(result.groupSlug, 'runtime-build-toolchain-compatibility')
  assert.equal(result.automerge, true)
  assert.ok(combinedLabels(result).has('release:weekly'))
  assert.ok(combinedLabels(result).has('review:automation'))
})

test('Go compiler security patches bypass age but never bypass acceptance', async () => {
  const result = await applyPackageRules({
    ...config,
    manager: 'dockerfile',
    datasource: 'docker',
    depName: 'golang',
    packageName: 'golang',
    packageFile: 'file-archiver-service/Dockerfile',
    currentVersion: '1.26.4',
    newVersion: '1.26.5',
    updateType: 'patch',
    isBreaking: false,
    isVulnerabilityAlert: false
  })
  assert.equal(result.minimumReleaseAge, '0 days')
  assert.equal(result.groupSlug, 'runtime-build-toolchain-compatibility')
  assert.equal(result.automerge, true)
  assert.ok(combinedLabels(result).has('release:weekly'))
})

test('a breaking Go compiler release remains an isolated roadmap decision', async () => {
  const result = await applyPackageRules({
    ...config,
    manager: 'dockerfile',
    datasource: 'docker',
    depName: 'golang',
    packageName: 'golang',
    packageFile: 'file-archiver-service/Dockerfile',
    currentVersion: '1.26.5',
    newVersion: '2.0.0',
    updateType: 'major',
    isBreaking: true,
    isVulnerabilityAlert: false
  })
  assert.equal(result.minimumReleaseAge, '0 days')
  assert.equal(result.groupName, null)
  assert.equal(result.automerge, false)
  assert.ok(combinedLabels(result).has('roadmap:required'))
  assert.ok(!combinedLabels(result).has('release:weekly'))
})

test('Go compiler scalar and both image refs share one Docker lookup', async () => {
  const lock = await readFile('compatibility.lock.yaml', 'utf8')
  const dockerfile = await readFile('file-archiver-service/Dockerfile', 'utf8')
  const lockedVersion = lock.match(/^  go: "([^"]+)"$/m)?.[1]
  assert.ok(lockedVersion)

  const scalarManager = config.customManagers.find(
    (manager) => manager.currentValueTemplate === '{{{goVersion}}}-alpine',
  )
  const imageManager = config.customManagers.find((manager) =>
    manager.matchStrings?.some((pattern) => pattern.includes('[a-z0-9_]+_image')),
  )
  assert.ok(scalarManager)
  assert.ok(imageManager)

  const scalar = extractRegex(lock, 'compatibility.lock.yaml', scalarManager).deps
    .find((dependency) => dependency.depName === 'golang')
  const image = extractRegex(lock, 'compatibility.lock.yaml', imageManager).deps
    .find((dependency) => dependency.depName === 'golang')
  const base = extractDockerfile(
    dockerfile,
    'file-archiver-service/Dockerfile',
    {},
  ).deps.find((dependency) => dependency.depName === 'golang')

  assert.deepEqual(
    [scalar, image, base].map(({ depName, datasource, currentValue }) => ({
      depName,
      datasource,
      currentValue,
    })),
    Array(3).fill({
      depName: 'golang',
      datasource: 'docker',
      currentValue: `${lockedVersion}-alpine`,
    }),
  )

  const minimumLine = lock.match(/^  go_module_minimum: "[^"]+"$/m)?.[0]
  assert.ok(minimumLine)
  const replacement = compile(scalarManager.autoReplaceStringTemplate, {
    ...scalar,
    newVersion: '1.26.4',
    newValue: '1.26.4-alpine',
  }, false)
  const updated = lock.replace(scalar.replaceString, replacement)
  const updatedScalar = extractRegex(
    updated,
    'compatibility.lock.yaml',
    scalarManager,
  ).deps.find((dependency) => dependency.depName === 'golang')
  assert.equal(updatedScalar.currentValue, '1.26.4-alpine')
  assert.ok(updated.includes(minimumLine))
})
