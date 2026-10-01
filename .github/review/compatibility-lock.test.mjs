import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repository = fileURLToPath(new URL('../..', import.meta.url))
const validator = join(repository, '.github/compatibility/read-lock.mjs')
const fixtureFiles = [
  'compatibility.lock.yaml',
  'file-archiver-service/Dockerfile',
  'file-archiver-service/go.mod',
  'web-app-file-archiver/package.json',
  'web-app-file-archiver/pnpm-lock.yaml',
]

async function fixture(t, transform = (source) => source) {
  const root = await mkdtemp(join(tmpdir(), 'archiver-lock-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const relative of fixtureFiles) {
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repository, relative), target)
  }
  const lockPath = join(root, 'compatibility.lock.yaml')
  await writeFile(lockPath, transform(await readFile(lockPath, 'utf8')))
  return spawnSync(process.execPath, [validator], { cwd: root, encoding: 'utf8' })
}

test('build lock does not require a stored OpenCloud release or Web major allowance', async (t) => {
  const result = await fixture(t, (source) => source
    .replace(/^opencloud:\n(?:[^\n]*\n)*?(?=toolchains:)/m, '')
    .replace(/^  go_module_minimum:.*\n/m, ''))
  assert.equal(result.status, 0, result.stderr)
  const resolved = JSON.parse(result.stdout)
  assert.ok(resolved.go_image.startsWith(`golang:${resolved.go_version}-`))
  assert.equal(Object.hasOwn(resolved, 'opencloud_image'), false)
})

test('build lock rejects compiler and image mismatches', async (t) => {
  const result = await fixture(t, (source) => source.replace(/^  go:.*$/m, '  go: "1.1.0"'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /go_image tag must match/)
})

test('build lock rejects duplicate compiler versions', async (t) => {
  const result = await fixture(t, (source) => source.replace(/^  go:.*$/m, '$&\n$&'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /duplicate toolchains.go/)
})
