import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

let event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))

const refreshNormalizedDependabotEvent = async () => {
  const original = event.pull_request
  if (original?.user?.login !== 'dependabot[bot]') return

  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify a Dependabot PR')
  const deadline = Date.now() + 5 * 60 * 1000
  const endpoint = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/pulls/${original.number}`

  while (Date.now() < deadline) {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10'
      }
    })
    if (!response.ok) throw new Error(`Could not refresh Dependabot PR #${original.number}: GitHub returned ${response.status}`)
    const live = await response.json()
    if (live?.user?.login !== 'dependabot[bot]' || live?.head?.repo?.full_name !== repository || live?.base?.repo?.full_name !== repository) {
      throw new Error('Live Dependabot PR identity or repository changed during policy review')
    }
    if (live?.head?.sha !== original?.head?.sha) {
      throw new Error('Dependabot PR head changed during policy review; the newer synchronize run must decide')
    }
    const labels = new Set((live.labels || []).map(({ name }) => name))
    const normalizedHead = String(live.body || '').match(/^Normalized head SHA:\s*([a-f0-9]{40})\s*$/mi)?.[1]
    if (labels.has('dependabot:normalized') && normalizedHead) {
      if (normalizedHead !== live.head.sha) throw new Error('Dependabot normalization marker is stale for the current head')
      event = { ...event, pull_request: live }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error('Timed out waiting for the trusted Dependabot normalizer')
}

await refreshNormalizedDependabotEvent()
const body = event.pull_request?.body || ''
const labels = new Set((event.pull_request?.labels || []).map(({ name }) => name))
const base = process.env.BASE_SHA
const head = process.env.HEAD_SHA
const errors = []
const warnings = []

if (!base || !head) {
  throw new Error('BASE_SHA and HEAD_SHA are required')
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim()
const changedFiles = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean)
const basePolicyFile = (file) => {
  try {
    return git('show', `${base}:${file}`)
  } catch {
    // Bootstrap only, before the policy files first exist on the base branch.
    return readFileSync(file, 'utf8')
  }
}
const scopes = JSON.parse(basePolicyFile('.github/review/roadmap-scopes.json'))
const roadmap = basePolicyFile('ROADMAP.md')

const roadmapIds = [...new Set(body.match(/RM-\d{3}/g) || [])]
if (roadmapIds.length === 0) {
  errors.push('PR body must name at least one roadmap item such as `Roadmap item: RM-003`.')
}

for (const id of roadmapIds) {
  if (!roadmap.includes(id) || !scopes[id]) {
    errors.push(`${id} is not an active roadmap scope.`)
  }
}

const matches = (file, pattern) => {
  if (pattern.endsWith('/**')) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2))
  return file === pattern
}

if (roadmapIds.length > 0) {
  const allowed = roadmapIds.flatMap((id) => scopes[id] || [])
  for (const file of changedFiles) {
    if (!allowed.some((pattern) => matches(file, pattern))) {
      errors.push(`${file} is outside the declared roadmap scope (${roadmapIds.join(', ')}).`)
    }
  }
}

for (const heading of ['Security impact:', 'Validation:']) {
  if (!body.toLowerCase().includes(heading.toLowerCase())) {
    errors.push(`PR body must include a \`${heading}\` section.`)
  }
}

const securityLabels = ['security:high', 'security:critical'].filter((label) => labels.has(label))
if (securityLabels.length > 0) {
  if (!/Security advisory:\s*\S+/i.test(body) || !/(github\.com\/advisories\/GHSA-|\bGHSA-[\w-]+|nvd\.nist\.gov\/vuln\/detail\/CVE-|\bCVE-\d{4}-\d+)/i.test(body)) {
    errors.push('High/Critical security PRs must contain a non-empty `Security advisory:` field and a GHSA/CVE reference.')
  }
  if (!/Security impact:\s*(High|Critical)\b/i.test(body)) {
    errors.push('The declared Security impact must match High or Critical.')
  }
}

const workflowFiles = changedFiles.filter((file) => file.startsWith('.github/workflows/'))
const automationBoundaries = changedFiles.filter((file) =>
  file.startsWith('.github/') ||
  file === 'renovate.json' ||
  file === 'compatibility.lock.yaml' ||
  file === 'scripts/acceptance.sh' ||
  file === 'scripts/package-web.go' ||
  file.startsWith('tests/e2e/') ||
  file.startsWith('web-app-file-archiver/tests/e2e/')
)
if (automationBoundaries.length > 0 && !labels.has('review:automation')) {
  errors.push('Automation, compatibility, packaging, and E2E gate changes require the maintainer-applied `review:automation` label.')
}

const sensitiveFiles = changedFiles.filter((file) =>
  file.includes('Dockerfile') ||
  automationBoundaries.includes(file) ||
  file === 'renovate.json' ||
  file.endsWith('go.mod') ||
  file.endsWith('package.json')
)
if (sensitiveFiles.length > 0 && !/Security impact:\s*\S+/i.test(body)) {
  errors.push('Security-sensitive changes require a non-empty Security impact statement.')
}

const workflowSources = []
for (const file of workflowFiles) {
  try {
    workflowSources.push({ file, source: git('show', `${head}:${file}`) })
  } catch {
    // A deleted workflow has no proposed content to inspect.
  }
}
if (workflowSources.length > 0) {
  const analyzer = basePolicyFile('.github/review/workflow-policy.py')
  const result = execFileSync('python3', ['-c', analyzer], {
    input: JSON.stringify(workflowSources),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  errors.push(...JSON.parse(result))
}

if (labels.has('release:weekly') && securityLabels.length > 0) {
  errors.push('A PR cannot be both weekly maintenance and an urgent security release.')
}

if (event.pull_request?.draft) {
  warnings.push('Draft PR: checks are informative until it is marked ready for review.')
}

const summary = process.env.GITHUB_STEP_SUMMARY
const report = [
  '# Automated PR review',
  '',
  `Roadmap scope: ${roadmapIds.join(', ') || 'missing'}`,
  `Changed files: ${changedFiles.length}`,
  `Security-sensitive files: ${sensitiveFiles.length}`,
  '',
  ...(errors.length ? ['## Blocking findings', ...errors.map((error) => `- ${error}`), ''] : ['No blocking policy findings.', '']),
  ...(warnings.length ? ['## Notes', ...warnings.map((warning) => `- ${warning}`), ''] : [])
].join('\n')

if (summary) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(summary, `${report}\n`)
}

console.log(report)
if (errors.length > 0) process.exit(1)
