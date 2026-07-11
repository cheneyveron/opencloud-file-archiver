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

test('compatibility lock exposes the approved embedded Web major', async (t) => {
  const result = await fixture(t)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).opencloud_web_major, '7')
})

test('embedded Web major is required exactly once', async (t) => {
  const missing = await fixture(t, (source) => source.replace(/^  embedded_web_major:.*\n/m, ''))
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /embedded_web_major/)

  const duplicate = await fixture(t, (source) => source.replace(
    /^  embedded_web_major:.*$/m,
    '  embedded_web_major: "7"\n  embedded_web_major: "7"',
  ))
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /duplicate opencloud\.embedded_web_major/)
})

test('embedded Web major rejects non-canonical roadmap allowances', async (t) => {
  for (const invalid of ['07', 'v7', '7.0']) {
    const result = await fixture(t, (source) => source.replace(
      /^  embedded_web_major:.*$/m,
      `  embedded_web_major: "${invalid}"`,
    ))
    assert.notEqual(result.status, 0, invalid)
    assert.match(result.stderr, /canonical non-negative integer/, invalid)
  }
})
