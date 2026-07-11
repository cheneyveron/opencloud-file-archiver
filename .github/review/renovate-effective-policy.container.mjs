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
