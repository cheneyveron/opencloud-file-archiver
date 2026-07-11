import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

let event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))

const refreshLivePullRequestEvent = async () => {
  const original = event.pull_request
  if (!original) return

  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify a pull request')
  const dependabot = original?.user?.login === 'dependabot[bot]'
  const deadline = Date.now() + (dependabot ? 5 * 60 * 1000 : 1)
  const endpoint = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/pulls/${original.number}`

  do {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10'
      }
    })
    if (!response.ok) throw new Error(`Could not refresh PR #${original.number}: GitHub returned ${response.status}`)
    const live = await response.json()
    if (!live?.head?.repo?.full_name || live?.base?.repo?.full_name !== repository) {
      throw new Error('Live PR head is missing or its base is not the reviewed repository')
    }
    if (live?.head?.sha !== original?.head?.sha) {
      throw new Error('PR head changed during policy review; the newer synchronize run must decide')
    }
    if (!dependabot) {
      event = { ...event, pull_request: live }
      return
    }
    if (live?.user?.login !== 'dependabot[bot]') {
      throw new Error('Live Dependabot PR identity changed during policy review')
    }
    const labels = new Set((live.labels || []).map(({ name }) => name))
    const normalizedHead = String(live.body || '').match(/^Normalized head SHA:\s*([a-f0-9]{40})\s*$/mi)?.[1]
    if (labels.has('dependabot:normalized') && normalizedHead) {
      if (normalizedHead !== live.head.sha) throw new Error('Dependabot normalization marker is stale for the current head')
      event = { ...event, pull_request: live }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for the trusted Dependabot normalizer')
}

await refreshLivePullRequestEvent()
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

const githubRaw = async (repository, path, ref) => {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required for upstream compatibility review')
  const endpoint = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10'
    }
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repository}/${path} at ${ref}`)
  return response.text()
}

const lockScalar = (source, key) => String(source).match(new RegExp(`^  ${key}: "([^"]+)"$`, 'm'))?.[1] || ''

const reviewProposedCompatibility = async () => {
  if (!changedFiles.includes('compatibility.lock.yaml')) return

  try {
    const validator = basePolicyFile('.github/compatibility/read-lock.mjs')
    execFileSync(process.execPath, ['--input-type=module', '--eval', validator], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    })
  } catch (error) {
    errors.push(`Proposed compatibility lock is invalid: ${String(error.stderr || error.message || error).trim()}`)
    return
  }

  const proposed = git('show', `${head}:compatibility.lock.yaml`)
  const previous = basePolicyFile('compatibility.lock.yaml')
  const librarySource = basePolicyFile('.github/maintenance/weekly-report-lib.mjs')
  const library = await import(`data:text/javascript;base64,${Buffer.from(librarySource).toString('base64')}`)
  const approvedWebMajor = lockScalar(proposed, 'embedded_web_major')
  errors.push(...library.webMajorAllowanceChangeFindings({
    automatedAuthor: library.isAutomatedDependencyPullRequest({
      authorLogin: event.pull_request?.user?.login,
      authorType: event.pull_request?.user?.type,
      headRef: event.pull_request?.head?.ref,
    }),
    currentMajor: lockScalar(previous, 'embedded_web_major'),
    labels,
    proposedMajor: approvedWebMajor,
  }).map((finding) => `${finding}.`))

  const upstreamRepository = lockScalar(proposed, 'repository')
  const stableRelease = lockScalar(proposed, 'stable_release')
  if (upstreamRepository !== 'opencloud-eu/opencloud' ||
      !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(stableRelease)) {
    errors.push('The proposed OpenCloud repository or stable release is not a trusted strict target.')
    return
  }

  try {
    const makefile = await githubRaw(upstreamRepository, 'services/web/Makefile', stableRelease)
    const versions = [...makefile.matchAll(/^WEB_ASSETS_VERSION\s*=\s*(\S+)\s*$/gm)]
    if (versions.length !== 1) {
      errors.push('The proposed OpenCloud target must declare exactly one WEB_ASSETS_VERSION.')
      return
    }
    const upstreamWeb = versions[0][1]
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(upstreamWeb)) {
      errors.push(`The proposed OpenCloud target embeds non-stable Web version ${upstreamWeb}.`)
      return
    }

    const packageJson = JSON.parse(await githubRaw('opencloud-eu/web', 'package.json', upstreamWeb))
    const pnpm = String(packageJson?.packageManager || '')
      .match(/^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1] || ''
    const findings = library.openCloudWebCompatibilityFindings({
      approvedWebMajor,
      selectedNode: lockScalar(proposed, 'node'),
      selectedPnpm: lockScalar(proposed, 'pnpm'),
      upstreamNode: packageJson?.volta?.node || '',
      upstreamPackageVersion: packageJson?.version || '',
      upstreamPnpm: pnpm,
      upstreamWeb,
    })
    errors.push(...findings.map((finding) => `OpenCloud compatibility: ${finding}.`))
  } catch (error) {
    errors.push(`Could not verify the proposed OpenCloud compatibility target: ${error.message || error}`)
  }
}

await reviewProposedCompatibility()

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
  file === 'scripts/app-store-entry.mjs' ||
  file === 'scripts/package-web.go' ||
  file.startsWith('tests/e2e/') ||
  file === 'web-app-file-archiver/src/manifest.json' ||
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

console.log(report)
if (errors.length > 0) process.exit(1)
