import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const caddyfile = await readFile(
  new URL('../../tests/e2e/Caddyfile', import.meta.url),
  'utf8',
)
const pullRequestWorkflow = await readFile(
  new URL('../workflows/pr-validation.yml', import.meta.url),
  'utf8',
)

test('both OpenCloud acceptance proxies preserve the browser-facing origin', () => {
  const expected = [
    'header_up Host {$E2E_PUBLIC_HOST}:{$E2E_PORT}',
    'header_up X-Forwarded-Host {$E2E_PUBLIC_HOST}:{$E2E_PORT}',
    'header_up X-Forwarded-Proto https',
  ]
  for (const header of expected) {
    assert.equal(caddyfile.split(header).length - 1, 2, `${header} must cover both proxies`)
  }
})

test('base-trusted PR review runs before any proposed revision code', () => {
  const review = pullRequestWorkflow.indexOf('- name: Review roadmap scope and security-sensitive changes')
  const unitTests = pullRequestWorkflow.indexOf('- name: Test the trusted review helpers')
  const renovateTests = pullRequestWorkflow.indexOf('- name: Test effective routing with the locked Renovate engine')
  assert.ok(review > 0)
  assert.ok(review < unitTests)
  assert.ok(review < renovateTests)
})
