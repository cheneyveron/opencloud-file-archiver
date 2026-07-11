import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const caller = await readFile(
  new URL('../workflows/release-after-merge.yml', import.meta.url),
  'utf8',
)
const release = await readFile(
  new URL('../workflows/release.yml', import.meta.url),
  'utf8',
)

test('post-merge callers cannot replace a pending urgent security dispatch', () => {
  assert.doesNotMatch(caller, /^concurrency:/m)
  assert.match(caller, /github\.event\.pull_request\.merged == true/)
  assert.match(caller, /'security:high'/)
  assert.match(caller, /'security:critical'/)
})

test('weekly routing cannot supersede urgent routing and both enter the formal release gate', () => {
  assert.match(caller, /!contains\(github\.event\.pull_request\.labels\.\*\.name, 'security:critical'\)/)
  assert.match(caller, /!contains\(github\.event\.pull_request\.labels\.\*\.name, 'security:high'\)/)
  assert.match(caller, /release_kind: urgent/)
  assert.match(caller, /release_kind: weekly/)
  assert.match(release, /^concurrency:\n  group: formal-release$/m)
})

test('any surviving formal release publishes current main, including queued security fixes', () => {
  assert.match(release, /main_sha=\$\(git rev-parse 'HEAD\^\{commit\}'\)/)
  assert.match(release, /source_sha=\$main_sha/)
  assert.match(release, /Main advanced after dispatch; accepting and releasing current main HEAD/)
})
