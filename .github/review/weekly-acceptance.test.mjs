import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { planWeeklyAcceptance, sameAcceptance, trustedAcceptanceRun } from '../maintenance/weekly-acceptance.mjs'

const repository = 'example/archiver'
const sourceSha = 'a'.repeat(40)
const upstream = {
  opencloud_release: 'v7.2.4',
  opencloud_image: `opencloudeu/opencloud:7.2.4@sha256:${'a'.repeat(64)}`,
  web_release: 'v8.0.0',
  web_url: 'https://github.com/opencloud-eu/web/releases/download/v8.0.0/web.tar.gz',
  web_sha256: 'a'.repeat(64),
  go: '1.25.0', node: '24.21.0', pnpm: '11.27.0',
}
const record = { status: 'passed', source_sha: sourceSha, upstream }
const run = {
  id: 42, status: 'completed', conclusion: 'success',
  repository: { full_name: repository }, head_repository: { full_name: repository },
  head_branch: 'main', event: 'schedule', path: '.github/workflows/weekly-maintenance.yml',
}

function inputs({ artifact = {}, workflow = {}, evidence = async () => record } = {}) {
  return {
    repository, sourceSha, upstream, releaseNeeded: false, blockersClear: true, evidence,
    api: async (endpoint) => endpoint.includes('/artifacts?') ? { artifacts: [{
      name: `weekly-acceptance-${sourceSha}`, expired: false, workflow_run: { id: run.id }, ...artifact,
    }] } : { ...run, ...workflow },
  }
}

test('reuse requires a passed result for the exact source and every upstream field', () => {
  assert.equal(sameAcceptance(record, sourceSha, upstream), true)
  assert.equal(sameAcceptance(record, 'b'.repeat(40), upstream), false)
  for (const key of Object.keys(upstream)) {
    assert.equal(sameAcceptance(record, sourceSha, { ...upstream, [key]: upstream[key] + '-changed' }), false, key)
  }
  for (const invalid of [null, {}, { ...record, status: 'failed' }, { ...record, source_sha: undefined }, { ...record, upstream: {} }]) {
    assert.equal(sameAcceptance(invalid, sourceSha, upstream), false)
  }
})

test('only successful trusted main maintenance or manual release runs are reusable', () => {
  assert.equal(trustedAcceptanceRun(run, repository), true)
  assert.equal(trustedAcceptanceRun({ ...run, event: 'workflow_dispatch', path: '.github/workflows/release.yml' }, repository), true)
  for (const override of [
    { event: 'pull_request' }, { event: 'push' }, { head_branch: 'feature/forged-proof' },
    { status: 'in_progress' }, { conclusion: 'failure' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } },
    { path: '.github/workflows/pr-validation.yml' },
  ]) {
    assert.equal(trustedAcceptanceRun({ ...run, ...override }, repository), false, JSON.stringify(override))
  }
})

test('an unchanged accepted combination skips full acceptance', async () => {
  const decision = await planWeeklyAcceptance(inputs())
  assert.equal(decision.needed, false)
  assert.match(decision.reason, /passed in trusted main run 42/)
})

test('changed versions or digests require full acceptance even without a dependency PR', async () => {
  for (const change of [
    { web_release: 'v8.0.1' }, { web_sha256: 'b'.repeat(64) },
    { opencloud_release: 'v7.2.5' }, { opencloud_image: upstream.opencloud_image.replace(/a{64}$/, 'b'.repeat(64)) },
  ]) {
    const decision = await planWeeklyAcceptance({ ...inputs(), upstream: { ...upstream, ...change } })
    assert.equal(decision.needed, true, JSON.stringify(change))
  }
})

test('a prepared release performs its own exact-artifact acceptance without a duplicate weekly run', async () => {
  const decision = await planWeeklyAcceptance({
    ...inputs(), releaseNeeded: true,
    api: async () => assert.fail('A release does not reuse or look up previous acceptance'),
  })
  assert.equal(decision.needed, false)
  assert.match(decision.reason, /mandatory exact-artifact acceptance/)
})

test('blocked publication does not suppress acceptance of an unknown combination', async () => {
  const decision = await planWeeklyAcceptance({
    ...inputs(), releaseNeeded: true, blockersClear: false,
    api: async () => ({ artifacts: [] }),
  })
  assert.equal(decision.needed, true)
})

test('failed or legacy evidence is never treated as a cached pass', async () => {
  for (const invalid of [{ ...record, status: 'failed' }, { status: 'passed', upstream }, {}]) {
    const decision = await planWeeklyAcceptance(inputs({ evidence: async () => invalid }))
    assert.equal(decision.needed, true)
  }
})

test('expired, incorrectly named, mismatched-run, or PR artifacts are rejected before download', async () => {
  for (const override of [
    { artifact: { expired: true } }, { artifact: { expired: undefined } },
    { artifact: { name: 'acceptance-123' } }, { workflow: { id: 43 } },
    { workflow: { event: 'pull_request' } }, { workflow: { head_branch: 'fork' } },
  ]) {
    const decision = await planWeeklyAcceptance(inputs({
      ...override, evidence: async () => assert.fail('Untrusted evidence must not be downloaded'),
    }))
    assert.equal(decision.needed, true)
  }
})

test('missing, unreadable, malformed, or unavailable history falls back to full acceptance', async () => {
  for (const override of [
    { api: async () => ({ artifacts: [] }) }, { api: async () => ({}) },
    { api: async () => { throw new Error('API unavailable') } },
    { evidence: async () => { throw new Error('Expired or corrupt download') } },
  ]) {
    const decision = await planWeeklyAcceptance({ ...inputs(), ...override })
    assert.equal(decision.needed, true)
  }
})

test('trusted main release evidence can also cover the unchanged weekly combination', async () => {
  const options = inputs({ workflow: { event: 'workflow_dispatch', path: '.github/workflows/release.yml' } })
  const api = options.api
  options.api = async (endpoint) => endpoint.includes('/artifacts?')
    ? { artifacts: endpoint.includes('name=release-acceptance-') ? [{
      name: `release-acceptance-${sourceSha}`, expired: false, workflow_run: { id: run.id },
    }] : [] }
    : api(endpoint)
  assert.equal((await planWeeklyAcceptance(options)).needed, false)
})

test('formal post-merge release evidence requires API proof of a same-repository PR merged into main', async () => {
  const postMerge = { ...run, event: 'pull_request', path: '.github/workflows/release-after-merge.yml',
    head_branch: 'renovate/weekly', head_sha: 'b'.repeat(40) }
  const merged = { state: 'closed', merged_at: '2026-10-01T00:00:00Z',
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: postMerge.head_sha, repo: { full_name: repository } } }
  for (const pr of [merged, { ...merged, merged_at: null }, { ...merged, state: 'open' },
    { ...merged, base: { ...merged.base, ref: 'develop' } },
    { ...merged, head: { ...merged.head, sha: 'c'.repeat(40) } },
    { ...merged, head: { ...merged.head, repo: { full_name: 'fork/repo' } } }]) {
    const trusted = pr === merged
    const options = inputs({ evidence: async () => {
      assert.equal(trusted, true, 'Never download unmerged or fork evidence')
      return record
    } })
    options.api = async (endpoint) => {
      if (endpoint.includes('/artifacts?')) return { artifacts: endpoint.includes('name=release-acceptance-') ? [{
        name: `release-acceptance-${sourceSha}`, expired: false, workflow_run: { id: run.id },
      }] : [] }
      if (endpoint.includes('/commits/')) return [pr]
      return postMerge
    }
    assert.equal((await planWeeklyAcceptance(options)).needed, !trusted)
  }
})

test('weekly conditions cannot bypass a release or skip discovery and security routing', async () => {
  const workflow = await readFile(new URL('../workflows/weekly-maintenance.yml', import.meta.url), 'utf8')
  const release = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8')
  const acceptance = workflow.match(/  acceptance-latest:[\s\S]*?(?=\n  release-if-needed:)/)?.[0]
  const publication = workflow.match(/  release-if-needed:[\s\S]*/)?.[0]
  assert.match(acceptance, /if: needs\.maintain\.outputs\.acceptance_needed == 'true'/)
  assert.match(acceptance, /ref: \$\{\{ needs\.maintain\.outputs\.source_sha \}\}/)
  assert.match(acceptance, /ACCEPTED_OPENCLOUD_TARGET: \$\{\{ needs\.maintain\.outputs\.opencloud_target \}\}/)
  assert.match(publication, /needs: maintain/)
  assert.doesNotMatch(publication, /acceptance-latest|acceptance_needed/)
  assert.match(publication, /needs\.maintain\.outputs\.blockers_clear == 'true'/)
  assert.match(publication, /uses: \.\/\.github\/workflows\/release\.yml/)
  assert.match(workflow, /run: node \.github\/compatibility\/resolve-opencloud\.mjs github-output/)
  assert.match(workflow, /run: node \.github\/maintenance\/weekly-report\.mjs/)
  assert.match(workflow, /--env RENOVATE_TOKEN/)
  const maintenance = workflow.match(/  maintain:[\s\S]*?(?=\n  acceptance-latest:)/)?.[0]
  assert.match(maintenance, /go run "golang\.org\/x\/vuln\/cmd\/govulncheck@\$GOVULNCHECK_VERSION" \.\/\.\.\./)
  assert.match(maintenance, /pnpm audit --audit-level high/)
  assert.match(maintenance, /SECURITY_AUDIT_CLEAR: \$\{\{ steps\.security\.outputs\.security_clear \}\}/)
  const report = await readFile(new URL('../maintenance/weekly-report.mjs', import.meta.url), 'utf8')
  assert.match(report, /!releasePreflight && process\.env\.SECURITY_AUDIT_CLEAR !== 'true'/)
  assert.match(release, /bash scripts\/acceptance\.sh \\\n\s+--frontend-zip/)
  assert.match(release, /name: release-acceptance-\$\{\{ needs\.plan\.outputs\.source_sha \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/acceptance-output/)
})
