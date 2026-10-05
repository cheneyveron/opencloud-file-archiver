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
const { api: npmVersioning } = await import(
  renovateModule('dist/modules/versioning/npm/index.js')
)
const { GlobalConfig } = await import(renovateModule('dist/config/global.js'))
const { normalizeDepNames } = await import(
  renovateModule('dist/workers/repository/extract/manager-files.js')
)
const { PnpmWorkspaceFile } = await import(
  renovateModule('dist/modules/manager/npm/schema.js')
)
const { extractPnpmWorkspaceFile } = await import(
  renovateModule('dist/modules/manager/npm/extract/pnpm.js')
)
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

const legacyNanoid = {
  manager: 'npm',
  datasource: 'npm',
  depName: 'nanoid@<3.3.18',
  packageName: 'nanoid',
  packageFile: 'web-app-file-archiver/pnpm-workspace.yaml',
  depType: 'pnpm-workspace.overrides',
  versioning: 'npm',
  currentValue: '3.3.19',
  currentVersion: '3.3.19',
  newVersion: '3.3.20',
  updateType: 'patch',
  isBreaking: false,
  isVulnerabilityAlert: false,
}

test('the real pnpm workspace override is extracted with the capped NanoID identity', async (t) => {
  const packageFile = 'web-app-file-archiver/pnpm-workspace.yaml'
  const workspace = PnpmWorkspaceFile.parse(await readFile(packageFile, 'utf8'))
  const originalGet = GlobalConfig.get
  const originalConfig = GlobalConfig.get()
  // Extraction reads the sibling lockfile. Scope its local directory to this
  // test without replacing or leaking Renovate's global configuration.
  const localDir = t.mock.method(GlobalConfig, 'get', (key) => (
    key === 'localDir' ? process.cwd() : originalGet(key)
  ))
  let extraction
  try {
    extraction = await extractPnpmWorkspaceFile(workspace, packageFile)
  } finally {
    localDir.mock.restore()
  }
  assert.equal(GlobalConfig.get, originalGet)
  assert.equal(GlobalConfig.get(), originalConfig)
  const matches = extraction.deps.filter(({ packageName }) => packageName === 'nanoid')
  assert.equal(matches.length, 1)
  const [dependency] = matches
  assert.equal(dependency.depName, 'nanoid@<3.3.18')
  assert.equal(dependency.packageName, 'nanoid')
  assert.equal(dependency.depType, 'pnpm-workspace.overrides')
  assert.equal(dependency.datasource, 'npm')
  assert.equal(dependency.currentValue, workspace.overrides['nanoid@<3.3.18'])
  const result = await applyPackageRules({
    ...config, ...dependency,
    manager: 'npm',
    packageFile,
    versioning: 'npm',
    currentVersion: dependency.currentValue,
    updateType: 'patch',
    isBreaking: false,
    isVulnerabilityAlert: false,
  })
  assert.equal(result.allowedVersions, '>=3.3.19 <4.0.0')
  assert.equal(npmVersioning.matches(dependency.currentValue, result.allowedVersions), true)
  assert.equal(result.automerge, true)
  assert.equal(result.groupSlug, 'weekly-non-breaking-maintenance')
})

test('the legacy NanoID override accepts maintained patches without major replacements', async () => {
  const result = await applyPackageRules({ ...config, ...legacyNanoid })
  assert.equal(result.allowedVersions, '>=3.3.19 <4.0.0')
  for (const version of ['3.3.19', '3.3.20', '3.4.0']) {
    assert.equal(npmVersioning.matches(version, result.allowedVersions), true, version)
  }
  for (const version of ['3.3.18', '4.0.0', '5.1.16', '6.0.1', '3.4.0-beta.1']) {
    assert.equal(npmVersioning.matches(version, result.allowedVersions), false, version)
  }
  assert.equal(result.automerge, true)
  assert.equal(result.groupSlug, 'weekly-non-breaking-maintenance')
  assert.deepEqual(result.schedule, ['* * * * 1'])
  assert.ok(combinedLabels(result).has('release:weekly'))
})

test('the legacy NanoID cap does not constrain other requirements, files, or managers', async () => {
  for (const change of [
    { depName: 'nanoid' },
    { depName: 'nanoid@<6.0.0' },
    { depType: 'dependencies' },
    { packageFile: 'another-app/pnpm-workspace.yaml' },
    { packageFile: 'web-app-file-archiver/package.json' },
    { manager: 'custom.regex' },
    {
      depName: 'nanoid', depType: 'dependencies',
      packageFile: 'web-app-file-archiver/package.json',
      currentVersion: '6.0.1', newVersion: '6.0.2',
    },
  ]) {
    const result = await applyPackageRules({ ...config, ...legacyNanoid, ...change })
    assert.ok(result.allowedVersions == null, JSON.stringify(change))
    assert.equal(result.automerge, true, JSON.stringify(change))
  }
})

for (const severity of ['HIGH', 'CRITICAL', 'MEDIUM']) {
  test(`the legacy NanoID cap preserves ${severity} patch security routing`, async () => {
    const alertRule = {
      matchDatasources: ['npm'],
      matchPackageNames: ['nanoid'],
      matchCurrentVersion: '3.3.19',
      isVulnerabilityAlert: true,
      vulnerabilitySeverity: severity,
      force: { ...config.vulnerabilityAlerts },
    }
    const result = await applyPackageRules({
      ...config, ...legacyNanoid,
      packageRules: [...config.packageRules, alertRule],
      isVulnerabilityAlert: true,
      vulnerabilitySeverity: severity,
    })
    assert.equal(result.allowedVersions, '>=3.3.19 <4.0.0')
    assert.equal(npmVersioning.matches('3.3.20', result.allowedVersions), true)
    assert.equal(result.automerge, true)
    assert.deepEqual(result.force.schedule, ['at any time'])
    assert.equal(result.force.groupName, null)
    assert.ok(!combinedLabels(result).has('roadmap:required'))
    if (severity === 'MEDIUM') {
      assert.ok(combinedLabels(result).has('release:weekly'))
      assert.ok(combinedLabels(result).has('security:triage'))
    } else {
      assert.equal(result.minimumReleaseAge, '0 days')
      assert.ok(combinedLabels(result).has(`security:${severity.toLowerCase()}`))
      assert.ok(!combinedLabels(result).has('release:weekly'))
    }
  })
}

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
      assert.deepEqual(result.force.schedule, ['at any time'])
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
})

test('upstream pairs run Sunday while application updates wait until Monday', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { isScheduledNow } = await import(renovateModule('dist/workers/repository/update/branch/schedule.js'))
  for (const [depName, manager, packageFile, day] of [
    ['golang', 'custom.regex', 'compatibility.lock.yaml', 0],
    ['golang', 'dockerfile', 'file-archiver-service/Dockerfile', 0],
    ['node', 'custom.regex', 'compatibility.lock.yaml', 0],
    ['pnpm', 'npm', 'web-app-file-archiver/package.json', 0],
    ['@playwright/test', 'npm', 'web-app-file-archiver/package.json', 0],
    ['mcr.microsoft.com/playwright', 'custom.regex', 'compatibility.lock.yaml', 0],
    ['actions/checkout', 'github-actions', '.github/workflows/pr-validation.yml', 0],
    ['vue', 'npm', 'web-app-file-archiver/package.json', 1],
    ['vitest', 'npm', 'web-app-file-archiver/package.json', 1],
    ['github.com/bodgit/sevenzip', 'gomod', 'file-archiver-service/go.mod', 1],
  ]) {
    const result = await applyPackageRules({
      ...config, manager, packageFile, depName, packageName: depName,
      currentVersion: '1.0.0', newVersion: '1.0.1', updateType: 'patch',
      isBreaking: false, isVulnerabilityAlert: false,
    })
    assert.deepEqual(result.schedule, [`* * * * ${day}`], depName)
    for (const hour of ['03:17', '18:00']) {
      t.mock.timers.setTime(new Date(`2026-09-20T${hour}:00Z`).getTime())
      assert.equal(isScheduledNow(result), day === 0, depName)
      t.mock.timers.setTime(new Date(`2026-09-21T${hour}:00Z`).getTime())
      assert.equal(isScheduledNow(result), day === 1, depName)
    }
    assert.equal(result.automerge, true, depName)
  }
})

test('OpenCloud Web and test helpers stay together without automerging major migrations', async () => {
  for (const depName of ['@opencloud-eu/extension-sdk', '@opencloud-eu/tsconfig', '@opencloud-eu/web-client', '@opencloud-eu/web-pkg', '@opencloud-eu/web-test-helpers']) {
    for (const isBreaking of [false, true]) {
      const result = await applyPackageRules({
        ...config, manager: 'npm', datasource: 'npm', depName, packageName: depName,
        packageFile: 'web-app-file-archiver/package.json', versioning: 'semver',
        currentVersion: '8.0.0', newVersion: isBreaking ? '9.0.0' : '8.1.0',
        updateType: isBreaking ? 'major' : 'minor', isBreaking, isVulnerabilityAlert: false,
      })
      assert.equal(result.groupSlug, 'opencloud-web-sdk-compatibility')
      assert.equal(result.automerge, !isBreaking)
      assert.equal(combinedLabels(result).has('roadmap:required'), isBreaking)
    }
  }
})

test('Node scalar and image share one Docker lookup and advance together', async () => {
  const lock = await readFile('compatibility.lock.yaml', 'utf8')
  const scalarManager = config.customManagers.find(
    (manager) => manager.currentValueTemplate === '{{{nodeVersion}}}-bookworm',
  )
  const imageManager = config.customManagers.find((manager) =>
    manager.matchStrings?.some((pattern) => pattern.includes('[a-z0-9_]+_image')),
  )
  const scalar = extractRegex(lock, 'compatibility.lock.yaml', scalarManager).deps
    .find((dependency) => dependency.depName === 'node')
  const image = extractRegex(lock, 'compatibility.lock.yaml', imageManager).deps
    .find((dependency) => dependency.depName === 'node')
  assert.deepEqual(
    [scalar, image].map(({ depName, datasource, currentValue }) => ({ depName, datasource, currentValue })),
    Array(2).fill({ depName: 'node', datasource: 'docker', currentValue: `${lock.match(/^  node: "([^"]+)"$/m)[1]}-bookworm` }),
  )
  const replacement = compile(scalarManager.autoReplaceStringTemplate, {
    ...scalar, newVersion: '24.22.0', newValue: '24.22.0-bookworm',
  }, false)
  const updated = lock.replace(scalar.replaceString, replacement)
  assert.match(updated, /^  node: "24\.22\.0"$/m)
  assert.equal(extractRegex(updated, 'compatibility.lock.yaml', scalarManager).deps[0].currentValue, '24.22.0-bookworm')
})


test('the official Renovate image is extracted and retains weekly age-gated toolchain routing', async () => {
  const lock = await readFile('compatibility.lock.yaml', 'utf8')
  const imageManager = config.customManagers.find((manager) =>
    manager.matchStrings?.some((pattern) => pattern.includes('[a-z0-9_]+_image')),
  )
  const dependency = extractRegex(lock, 'compatibility.lock.yaml', imageManager).deps
    .find(({ depName }) => depName === 'renovate/renovate')
  assert.ok(dependency)
  // Match Renovate's real extraction pipeline before applying package-name rules.
  normalizeDepNames(dependency)
  assert.equal(dependency.packageName, 'renovate/renovate')
  assert.equal(dependency.datasource, 'docker')
  assert.match(dependency.currentDigest, /^sha256:[a-f0-9]{64}$/)
  const result = await applyPackageRules({
    ...config, ...dependency,
    manager: 'custom.regex',
    packageFile: 'compatibility.lock.yaml',
    currentVersion: '44.132.2',
    newVersion: '44.132.3',
    updateType: 'patch',
    isBreaking: false,
    isVulnerabilityAlert: false,
  })
  assert.equal(result.minimumReleaseAge, '3 days')
  assert.equal(result.minimumReleaseAgeBehaviour, undefined)
  assert.equal(result.groupSlug, 'runtime-build-toolchain-compatibility')
  assert.equal(result.automerge, true)
  assert.deepEqual(result.schedule, ['* * * * 0'])
  assert.ok(combinedLabels(result).has('release:weekly'))
  assert.ok(combinedLabels(result).has('review:automation'))
})

test('future breaking Renovate releases still require an isolated roadmap decision', async () => {
  const result = await applyPackageRules({
    ...config,
    manager: 'custom.regex',
    datasource: 'docker',
    depName: 'renovate/renovate',
    packageName: 'renovate/renovate',
    packageFile: 'compatibility.lock.yaml',
    currentVersion: '44.132.2',
    newVersion: '45.0.0',
    updateType: 'major',
    isBreaking: true,
    isVulnerabilityAlert: false,
  })
  assert.equal(result.minimumReleaseAge, '3 days')
  assert.equal(result.groupName, null)
  assert.equal(result.automerge, false)
  assert.ok(combinedLabels(result).has('roadmap:required'))
  assert.ok(!combinedLabels(result).has('release:weekly'))
  assert.ok(combinedLabels(result).has('review:automation'))
})
