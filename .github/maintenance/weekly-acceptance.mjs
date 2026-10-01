import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCurrentOpenCloud } from '../compatibility/resolve-opencloud.mjs'

const cli = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
})
const github = (endpoint) => JSON.parse(cli('gh', ['api', endpoint]))

function readEvidence(repository, runId, name) {
  const directory = mkdtempSync(join(tmpdir(), 'archiver-acceptance-baseline-'))
  try {
    cli('gh', ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', directory])
    return JSON.parse(readFileSync(join(directory, 'resolved-components.json'), 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function trustedAcceptanceRun(run, repository, mergedPullRequests = []) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) return false
  if (run.head_branch === 'main' && ['schedule', 'workflow_dispatch'].includes(run.event) &&
      ['.github/workflows/weekly-maintenance.yml', '.github/workflows/release.yml'].includes(run.path)) return true
  return run.event === 'pull_request' && run.path === '.github/workflows/release-after-merge.yml' &&
    mergedPullRequests.some((pr) => pr.state === 'closed' && pr.merged_at &&
      pr.base?.ref === 'main' && pr.base.repo?.full_name === repository &&
      pr.head?.repo?.full_name === repository && pr.head.sha === run.head_sha)
}

export function sameAcceptance(record, sourceSha, upstream) {
  if (record?.status !== 'passed' || record.source_sha !== sourceSha) return false
  try {
    assertCurrentOpenCloud(record.upstream, upstream)
    return true
  } catch {
    return false
  }
}

export async function planWeeklyAcceptance({
  repository, sourceSha, upstream, releaseNeeded, blockersClear,
  api = github, evidence = readEvidence,
}) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  if (releaseNeeded && blockersClear) {
    return { needed: false, reason: 'The release workflow will run mandatory exact-artifact acceptance.' }
  }

  try {
    for (const name of [`weekly-acceptance-${sourceSha}`, `release-acceptance-${sourceSha}`]) {
      const response = await api(`repos/${repository}/actions/artifacts?name=${name}&per_page=100`)
      assert.ok(Array.isArray(response.artifacts), 'Invalid acceptance artifact listing')
      for (const artifact of response.artifacts) {
        if (artifact.name !== name || artifact.expired !== false || !Number.isSafeInteger(artifact.workflow_run?.id)) continue
        const run = await api(`repos/${repository}/actions/runs/${artifact.workflow_run.id}`)
        if (run.id !== artifact.workflow_run.id) continue
        let trusted = trustedAcceptanceRun(run, repository)
        if (!trusted && name.startsWith('release-acceptance-') &&
            run.event === 'pull_request' && run.path === '.github/workflows/release-after-merge.yml' &&
            /^[a-f0-9]{40}$/.test(run.head_sha || '')) {
          const pulls = await api(`repos/${repository}/commits/${run.head_sha}/pulls?per_page=100`)
          trusted = Array.isArray(pulls) && trustedAcceptanceRun(run, repository, pulls)
        }
        if (!trusted) continue
        try {
          if (sameAcceptance(await evidence(repository, run.id, name), sourceSha, upstream)) {
            return { needed: false, reason: `This source and latest upstream combination passed in trusted main run ${run.id}.` }
          }
        } catch {
          // Missing, expired, or corrupt evidence never counts as acceptance.
        }
      }
    }
  } catch {
    return { needed: true, reason: 'Acceptance history is unavailable; full acceptance is required.' }
  }
  return { needed: true, reason: 'No reusable success for this source and latest upstream combination; full acceptance is required.' }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  assert.match(repository || '', /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
  const sourceSha = cli('git', ['rev-parse', 'HEAD']).trim()
  const decision = await planWeeklyAcceptance({
    repository, sourceSha,
    upstream: JSON.parse(process.env.OPENCLOUD_TARGET),
    releaseNeeded: process.env.RELEASE_NEEDED === 'true',
    blockersClear: process.env.BLOCKERS_CLEAR === 'true',
  })
  console.log(decision.reason)
  assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required')
  appendFileSync(process.env.GITHUB_OUTPUT, `acceptance_needed=${decision.needed}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Weekly acceptance decision\n\n${decision.reason}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
