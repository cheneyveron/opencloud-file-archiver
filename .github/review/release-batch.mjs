import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  isAbandonedRenovatePullRequest,
  latestRequiredCheckStates,
  REQUIRED_CHECKS,
} from '../maintenance/weekly-report-lib.mjs'

const terminalFailureStates = new Set([
  'action_required',
  'cancelled',
  'error',
  'failure',
  'stale',
  'startup_failure',
  'timed_out',
])

export function analyzeWeeklyReleaseBatch(pullRequests) {
  const blocking = []
  const quarantined = []
  const abandoned = []

  for (const pr of Array.isArray(pullRequests) ? pullRequests : []) {
    if (isAbandonedRenovatePullRequest(pr)) {
      abandoned.push(pr.number)
      continue
    }
    const states = latestRequiredCheckStates(pr.statusCheckRollup)
    const failed = REQUIRED_CHECKS.filter((name) => terminalFailureStates.has(states[name]))
    if (failed.length > 0) {
      quarantined.push({ number: pr.number, failed })
    } else {
      blocking.push({ number: pr.number, states })
    }
  }

  return {
    ready: blocking.length === 0,
    blocking,
    quarantined,
    abandoned,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '[]')
  process.stdout.write(`${JSON.stringify(analyzeWeeklyReleaseBatch(input))}\n`)
}
