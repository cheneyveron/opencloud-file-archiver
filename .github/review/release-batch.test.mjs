import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeWeeklyReleaseBatch } from './release-batch.mjs'

const check = (name, conclusion, startedAt, detailsUrl = '') => ({
  name,
  conclusion,
  startedAt,
  detailsUrl,
})
const successful = [
  check('Automated review / policy', 'SUCCESS', '2026-07-11T00:01:00Z'),
  check('Full acceptance / locked OpenCloud stable', 'SUCCESS', '2026-07-11T00:01:00Z'),
  check('CodeQL / go', 'SUCCESS', '2026-07-11T00:01:00Z'),
  check('CodeQL / javascript-typescript', 'SUCCESS', '2026-07-11T00:01:00Z'),
]

test('passing, pending, or missing weekly PR checks keep the batch open', () => {
  const result = analyzeWeeklyReleaseBatch([
    { number: 20, title: 'Passing', headRefName: 'renovate/passing', labels: [{ name: 'dependencies' }], statusCheckRollup: successful },
    { number: 21, title: 'Starting', headRefName: 'renovate/starting', labels: [{ name: 'dependencies' }], statusCheckRollup: [] },
  ])
  assert.equal(result.ready, false)
  assert.deepEqual(result.blocking.map(({ number }) => number), [20, 21])
})

test('two weekly callers become ready only after the final passing sibling closes', () => {
  const whileSiblingIsOpen = analyzeWeeklyReleaseBatch([{
    number: 25,
    title: 'Accepted sibling awaiting automerge',
    headRefName: 'renovate/accepted-sibling',
    labels: [{ name: 'dependencies' }, { name: 'release:weekly' }],
    statusCheckRollup: successful,
  }])
  assert.equal(whileSiblingIsOpen.ready, false)

  const firstCallerAfterFinalMerge = analyzeWeeklyReleaseBatch([])
  const finalMergeCaller = analyzeWeeklyReleaseBatch([])
  assert.equal(firstCallerAfterFinalMerge.ready, true)
  assert.equal(finalMergeCaller.ready, true)
})

test('terminally failed and abandoned PRs cannot suppress an accepted release', () => {
  const result = analyzeWeeklyReleaseBatch([
    {
      number: 22,
      title: 'Incompatible toolchain',
      headRefName: 'renovate/toolchain',
      labels: [{ name: 'dependencies' }],
      statusCheckRollup: [
        ...successful,
        check('Full acceptance / locked OpenCloud stable', 'FAILURE', '2026-07-11T00:02:00Z'),
      ],
    },
    {
      number: 23,
      title: 'Old update - abandoned',
      headRefName: 'renovate/old-update',
      labels: [{ name: 'dependencies' }, { name: 'release:weekly' }],
      statusCheckRollup: [],
    },
  ])
  assert.equal(result.ready, true)
  assert.deepEqual(result.quarantined, [{
    number: 22,
    failed: ['Full acceptance / locked OpenCloud stable'],
  }])
  assert.deepEqual(result.abandoned, [23])
})

test('neutral and skipped required checks wait for GitHub to finish automerge', () => {
  for (const conclusion of ['NEUTRAL', 'SKIPPED']) {
    const result = analyzeWeeklyReleaseBatch([{
      number: 26,
      title: `${conclusion} accepted sibling`,
      headRefName: 'renovate/accepted-sibling',
      labels: [{ name: 'dependencies' }, { name: 'release:weekly' }],
      statusCheckRollup: [
        ...successful,
        check('CodeQL / go', conclusion, '2026-07-11T00:04:00Z'),
      ],
    }])
    assert.equal(result.ready, false)
    assert.deepEqual(result.quarantined, [])
  }
})

test('a queued rerun cannot be mistaken for the older terminal failure', () => {
  const result = analyzeWeeklyReleaseBatch([{
    number: 24,
    title: 'Rerun',
    headRefName: 'renovate/rerun',
    labels: [{ name: 'dependencies' }],
    statusCheckRollup: [
      ...successful,
      check(
        'CodeQL / go',
        'FAILURE',
        '2026-07-11T00:03:00Z',
        'https://github.com/example/repo/actions/runs/300/job/4001',
      ),
      {
        name: 'CodeQL / go',
        status: 'QUEUED',
        detailsUrl: 'https://github.com/example/repo/actions/runs/300/job/4002',
      },
    ],
  }])
  assert.equal(result.ready, false)
  assert.deepEqual(result.quarantined, [])
})
