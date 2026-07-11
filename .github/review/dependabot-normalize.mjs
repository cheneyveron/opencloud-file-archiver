import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEPENDABOT = 'dependabot[bot]'
const INTAKE_NAME = 'Dependabot intake'
const INTAKE_PATH = '.github/workflows/dependabot-intake.yml'
const BLOCK_START = '<!-- dependabot-normalizer:start -->'
const BLOCK_END = '<!-- dependabot-normalizer:end -->'
const API_VERSION = '2026-03-10'

const LABELS = {
  dependencies: { color: '0366d6', description: 'Automated dependency update' },
  'dependabot:normalized': { color: '0e8a16', description: 'Live PR metadata was verified by the trusted normalizer' },
  'security:triage': { color: 'fbca04', description: 'Security severity or alert association needs review' },
  'security:low': { color: 'c5def5', description: 'Trusted Low-severity Dependabot security update' },
  'security:medium': { color: 'e4e669', description: 'Trusted Medium-severity Dependabot security update' },
  'security:high': { color: 'd93f0b', description: 'Trusted High-severity runtime security release' },
  'security:critical': { color: 'b60205', description: 'Trusted Critical runtime security release' },
  'release:weekly': { color: '1d76db', description: 'Merge enters the next weekly accepted release' },
  'roadmap:required': { color: '5319e7', description: 'Breaking or unclassified update needs a roadmap decision' },
  'review:automation': { color: '5319e7', description: 'Trusted bot changed an automation boundary' }
}

const MANAGED_LABELS = new Set(Object.keys(LABELS))
const SEVERITY_RANK = new Map([
  ['low', 1],
  ['medium', 2],
  ['high', 3],
  ['critical', 4]
])

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const cleanScalar = (value) => {
  const trimmed = String(value || '').trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const calculateUpdateType = (previousVersion, newVersion) => {
  const previous = String(previousVersion || '').replace(/^v/, '').split(/[.+-]/)
  const next = String(newVersion || '').replace(/^v/, '').split(/[.+-]/)
  if (!previousVersion || !newVersion || previousVersion === newVersion) return ''
  if (previous[0] !== next[0]) return 'version-update:semver-major'
  if (previous[1] !== next[1]) return 'version-update:semver-minor'
  return 'version-update:semver-patch'
}

export function parseDependabotMetadata (commitMessage) {
  const fragment = String(commitMessage || '').match(/^---\s*$([\s\S]*?)^\.\.\.\s*$/m)?.[1] || ''
  const dependencies = []
  let current

  for (const line of fragment.split('\n')) {
    const name = line.match(/^\s*-\s+dependency-name:\s*(.+?)\s*$/)
    if (name) {
      current = { dependencyName: cleanScalar(name[1]) }
      dependencies.push(current)
      continue
    }
    if (!current) continue
    const field = line.match(/^\s+(dependency-type|update-type|dependency-version):\s*(.+?)\s*$/)
    if (!field) continue
    const key = {
      'dependency-type': 'dependencyType',
      'update-type': 'updateType',
      'dependency-version': 'newVersion'
    }[field[1]]
    current[key] = cleanScalar(field[2])
  }

  const versions = new Map()
  const versionPattern = /^Updates `([^`]+)` (?:from (\S+) )?to (\S+)\s*$/gm
  let match
  while ((match = versionPattern.exec(String(commitMessage || ''))) !== null) {
    const entries = versions.get(match[1]) || []
    entries.push({ previousVersion: match[2] || '', newVersion: match[3] })
    versions.set(match[1], entries)
  }

  const firstBump = String(commitMessage || '').match(/^Bumps .* from (v?\d\S*) to (v?\d\S*)\.$/m)
  const counters = new Map()
  for (const [index, dependency] of dependencies.entries()) {
    const offset = counters.get(dependency.dependencyName) || 0
    counters.set(dependency.dependencyName, offset + 1)
    const linked = versions.get(dependency.dependencyName)?.[offset]
    dependency.previousVersion = linked?.previousVersion || (index === 0 ? firstBump?.[1] || '' : '')
    dependency.newVersion = dependency.newVersion || linked?.newVersion || (index === 0 ? firstBump?.[2] || '' : '')
    dependency.updateType = dependency.updateType || calculateUpdateType(dependency.previousVersion, dependency.newVersion)
  }

  return dependencies
}

const parseVersion = (value) => {
  const normalized = String(value || '').trim().replace(/^v(?=\d)/, '').split('+', 1)[0]
  const match = normalized.match(/^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    core: match[1].split('.').map(Number),
    prerelease: match[2]?.split('.') || []
  }
}

const compareIdentifiers = (left, right) => {
  const leftNumber = /^\d+$/.test(left)
  const rightNumber = /^\d+$/.test(right)
  if (leftNumber && rightNumber) return Number(left) - Number(right)
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
  return left.localeCompare(right)
}

export function compareVersions (candidate, minimum) {
  if (String(candidate) === String(minimum)) return 0
  const left = parseVersion(candidate)
  const right = parseVersion(minimum)
  if (!left || !right) return null
  const coreLength = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < coreLength; index += 1) {
    const difference = (left.core[index] || 0) - (right.core[index] || 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const preLength = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < preLength; index += 1) {
    if (left.prerelease[index] === undefined) return -1
    if (right.prerelease[index] === undefined) return 1
    const difference = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export const versionAtLeast = (candidate, minimum) => {
  const comparison = compareVersions(candidate, minimum)
  return comparison !== null && comparison >= 0
}

const normalizePath = (value) => String(value || '').replace(/^\/+/, '').replaceAll('\\', '/')
const normalizeName = (value) => String(value || '').trim().toLowerCase()

export function matchAlerts ({ dependencies, alerts, changedFiles }) {
  const files = new Set(changedFiles.map(normalizePath))
  const matches = []
  for (const alert of alerts) {
    const packageName = alert?.dependency?.package?.name || alert?.security_vulnerability?.package?.name
    const manifestPath = normalizePath(alert?.dependency?.manifest_path)
    const patchedVersion = alert?.security_vulnerability?.first_patched_version?.identifier
    const dependency = dependencies.find((candidate) => {
      const previousComparison = compareVersions(candidate.previousVersion, patchedVersion)
      const newComparison = compareVersions(candidate.newVersion, patchedVersion)
      return normalizeName(candidate.dependencyName) === normalizeName(packageName) &&
        candidate.previousVersion && candidate.newVersion && patchedVersion &&
        previousComparison !== null && newComparison !== null &&
        previousComparison < 0 && newComparison >= 0
    })
    if (!dependency || !manifestPath || !files.has(manifestPath)) continue
    const severity = String(alert?.security_vulnerability?.severity || alert?.security_advisory?.severity || '').toLowerCase()
    if (!SEVERITY_RANK.has(severity)) continue
    matches.push({ alert, dependency, severity })
  }
  return matches
}

const highestSeverity = (matches) => matches.reduce((highest, candidate) =>
  (SEVERITY_RANK.get(candidate.severity) || 0) > (SEVERITY_RANK.get(highest) || 0)
    ? candidate.severity
    : highest
, '')

const automationBoundary = (file) => {
  const normalized = normalizePath(file)
  return normalized.startsWith('.github/') ||
    normalized === 'renovate.json' ||
    normalized === 'compatibility.lock.yaml' ||
    normalized === 'scripts/acceptance.sh' ||
    normalized === 'scripts/package-web.go' ||
    normalized.startsWith('tests/e2e/') ||
    normalized.startsWith('web-app-file-archiver/tests/e2e/')
}

const expectedDependencyFile = (file, ecosystem) => {
  const normalized = normalizePath(file)
  const basename = normalized.split('/').at(-1)
  if (ecosystem === 'npm_and_yarn') {
    return ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(basename)
  }
  if (ecosystem === 'gomod' || ecosystem === 'go_modules') return basename === 'go.mod' || basename === 'go.sum'
  // These ecosystems are still classified and labeled, but their files are
  // automation boundaries and therefore never enter unattended auto-merge.
  if (ecosystem === 'github_actions') return normalized.startsWith('.github/workflows/') && /\.ya?ml$/.test(normalized)
  if (ecosystem === 'docker') return basename === 'Dockerfile' || basename?.startsWith('Dockerfile.')
  return false
}

const safeCode = (value) => `\`${String(value).replaceAll('`', '')}\``
const titleCase = (value) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : 'Unknown'

const advisoryReferences = (matches) => {
  const references = new Set()
  for (const { alert } of matches) {
    const ghsa = String(alert?.security_advisory?.ghsa_id || '')
    const cve = String(alert?.security_advisory?.cve_id || '')
    if (/^GHSA-[\w-]+$/i.test(ghsa)) references.add(`https://github.com/advisories/${ghsa.toUpperCase()}`)
    if (/^CVE-\d{4}-\d+$/i.test(cve)) references.add(`https://nvd.nist.gov/vuln/detail/${cve.toUpperCase()}`)
  }
  return [...references]
}

export function makeNormalizationPlan ({ dependencies, alerts, changedFiles, ecosystem, headSha, existingBody = '' }) {
  invariant(dependencies.length > 0, 'Verified Dependabot commit metadata contains no dependencies')
  const matchedAlerts = matchAlerts({ dependencies, alerts, changedFiles })
  const severity = highestSeverity(matchedAlerts)
  const knownUpdateTypes = dependencies.every(({ updateType }) =>
    ['version-update:semver-patch', 'version-update:semver-minor', 'version-update:semver-major'].includes(updateType)
  )
  const major = dependencies.some(({ updateType }) => updateType === 'version-update:semver-major')
  const touchesAutomation = changedFiles.some(automationBoundary)
  const onlyExpectedDependencyFiles = changedFiles.length > 0 &&
    changedFiles.every((file) => expectedDependencyFile(file, ecosystem))
  const enableAutoMerge = Boolean(severity) && knownUpdateTypes && !major &&
    onlyExpectedDependencyFiles && !touchesAutomation
  const labels = new Set(['dependencies', 'dependabot:normalized'])

  if (severity) labels.add(`security:${severity}`)
  else labels.add('security:triage')
  if (severity === 'low' || severity === 'medium') labels.add('release:weekly')
  if (major || !knownUpdateTypes || !severity || !onlyExpectedDependencyFiles || touchesAutomation) labels.add('roadmap:required')
  if (touchesAutomation) labels.add('review:automation')

  const references = advisoryReferences(matchedAlerts)
  const impact = severity
    ? `${titleCase(severity)} Dependabot alert resolved by the signed update metadata.`
    : 'Unknown; no matching open Dependabot alert with a verified patched version was found, so automatic merge is disabled.'
  const advisory = references.length > 0
    ? references.join(', ')
    : 'Requires triage; GitHub did not return an unambiguous GHSA/CVE match.'
  const updateTypes = [...new Set(dependencies.map(({ updateType }) => updateType || 'unclassified'))]
  const dependencyNames = dependencies.map(({ dependencyName }) => safeCode(dependencyName)).join(', ')
  const block = [
    BLOCK_START,
    'Roadmap item: RM-001',
    `Security impact: ${impact}`,
    `Security advisory: ${advisory}`,
    'Validation: Automated review / policy and Full acceptance / locked OpenCloud stable must both pass before merge.',
    `Unexpected changes: None expected outside the signed Dependabot update for ${dependencyNames}.`,
    `Dependency update type: ${updateTypes.join(', ')}${major ? ' (major; manual roadmap decision required)' : ''}`,
    `Normalized head SHA: ${headSha || 'missing'}`,
    `Automatic merge: ${enableAutoMerge ? 'eligible after required checks' : 'disabled by trusted classification'}`,
    BLOCK_END
  ].join('\n')

  return {
    body: replaceManagedBlock(existingBody, block),
    enableAutoMerge,
    labels: [...labels].sort(),
    major,
    matchedAlerts,
    severity
  }
}

export function replaceManagedBlock (body, block) {
  const pattern = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`, 'g')
  const withoutOldBlock = String(body || '').replace(pattern, '').trim()
  const maximumNativeLength = Math.max(0, 60_000 - block.length)
  const nativeBody = withoutOldBlock.length > maximumNativeLength
    ? `${withoutOldBlock.slice(0, maximumNativeLength)}\n\n_[Original Dependabot description truncated by the trusted normalizer.]_`
    : withoutOldBlock
  return nativeBody ? `${nativeBody}\n\n${block}` : block
}

export function validateWorkflowRun ({ event, repository }) {
  const run = event?.workflow_run
  invariant(event?.action === 'completed', 'Unexpected workflow_run action')
  invariant(event?.repository?.full_name === repository, 'Event repository does not match GITHUB_REPOSITORY')
  invariant(run?.name === INTAKE_NAME, 'Unexpected triggering workflow name')
  invariant(run?.event === 'pull_request', 'Triggering run was not a pull_request workflow')
  invariant(run?.conclusion === 'success', 'Dependabot intake did not succeed')
  invariant(run?.head_repository?.full_name === repository, 'Triggering run came from another repository')
  invariant(Array.isArray(run?.pull_requests) && run.pull_requests.length === 1, 'Triggering run must identify exactly one pull request')
  return {
    botTriggered: run?.actor?.login === DEPENDABOT && run?.triggering_actor?.login === DEPENDABOT,
    pullNumber: run.pull_requests[0].number
  }
}

class GitHubApi {
  constructor ({ token, apiUrl = 'https://api.github.com' }) {
    invariant(token, 'GITHUB_TOKEN is required')
    this.token = token
    this.apiUrl = apiUrl.replace(/\/$/, '')
  }

  async request (path, { method = 'GET', body, allowed = [] } = {}) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': API_VERSION
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (allowed.includes(response.status)) return { status: response.status, data: null }
    const text = await response.text()
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`)
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }

  async graphql (query, variables) {
    const { data } = await this.request('/graphql', { method: 'POST', body: { query, variables } })
    if (data?.errors?.length) throw new Error(`GitHub GraphQL failed: ${data.errors.map(({ message }) => message).join('; ')}`)
    return data?.data
  }
}

const paginated = async (api, path, expectedCount) => {
  const values = []
  let exhausted = false
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const { data } = await api.request(`${path}${separator}per_page=100&page=${page}`)
    invariant(Array.isArray(data), `Expected an array from ${path}`)
    values.push(...data)
    if (data.length < 100) {
      exhausted = true
      break
    }
  }
  invariant(exhausted, `Refusing to use a truncated API result from ${path}`)
  if (expectedCount !== undefined) invariant(values.length === expectedCount, `Expected ${expectedCount} values from ${path}, received ${values.length}`)
  return values
}

const ensureLabel = async (api, repository, name) => {
  const definition = LABELS[name]
  invariant(definition, `No trusted definition exists for label ${name}`)
  const encoded = encodeURIComponent(name)
  const existing = await api.request(`/repos/${repository}/labels/${encoded}`, { allowed: [404] })
  if (existing.status === 404) {
    const created = await api.request(`/repos/${repository}/labels`, {
      method: 'POST',
      body: { name, ...definition },
      allowed: [422]
    })
    // A simultaneous normalization may have created the same label after our
    // GET. Accept that race only when a fresh read proves the trusted name now
    // exists; other validation failures remain fatal.
    if (created.status === 422) {
      const raced = await api.request(`/repos/${repository}/labels/${encoded}`, { allowed: [404] })
      invariant(raced.status !== 404, `Could not create trusted label ${name}`)
    }
  }
}

const setAutoMerge = async (api, pullRequest, enabled) => {
  if (enabled && !pullRequest.auto_merge) {
    await api.graphql(`
      mutation EnableDependabotAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { number }
        }
      }
    `, { pullRequestId: pullRequest.node_id })
  } else if (!enabled && pullRequest.auto_merge) {
    await api.graphql(`
      mutation DisableDependabotAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
          pullRequest { number }
        }
      }
    `, { pullRequestId: pullRequest.node_id })
  }
}

const verifyLivePullRequest = (pullRequest, { event, repository, run }) => {
  invariant(pullRequest?.state === 'open', 'Pull request is no longer open')
  invariant(pullRequest?.user?.login === DEPENDABOT && pullRequest?.user?.type === 'Bot', 'Pull request author is not Dependabot')
  invariant(pullRequest?.head?.repo?.full_name === repository, 'Pull request head repository is not trusted')
  invariant(pullRequest?.base?.repo?.full_name === repository, 'Pull request base repository is not trusted')
  invariant(pullRequest?.base?.ref === event.repository.default_branch, 'Pull request does not target the default branch')
  invariant(pullRequest?.head?.ref?.startsWith('dependabot/'), 'Pull request does not use a Dependabot branch')
  invariant(pullRequest?.head?.sha === run.head_sha, 'Triggering run is stale for the current pull request head')
  return pullRequest
}

const getVerifiedLivePullRequest = async (api, pullNumber, context) => {
  const { data } = await api.request(`/repos/${context.repository}/pulls/${pullNumber}`)
  return verifyLivePullRequest(data, context)
}

export async function normalizeDependabot ({ event, repository, api }) {
  const { botTriggered, pullNumber } = validateWorkflowRun({ event, repository })
  const run = event.workflow_run

  // Everything before the first write is a fresh API verification. No artifact or
  // pull-request-controlled file is trusted by this workflow.
  const { data: workflow } = await api.request(`/repos/${repository}/actions/workflows/${run.workflow_id}`)
  invariant(workflow?.path === INTAKE_PATH && workflow?.name === INTAKE_NAME, 'Triggering workflow identity does not match the trusted intake path')

  const liveContext = { event, repository, run }
  const pullRequest = await getVerifiedLivePullRequest(api, pullNumber, liveContext)

  // A maintainer or any other non-Dependabot actor may have pushed to a bot
  // branch after auto-merge was enabled. This path performs only the defensive
  // write: re-check the live identity/SHA and revoke auto-merge. It never
  // updates the body or grants trusted classification labels.
  if (!botTriggered) {
    const beforeQuarantine = await getVerifiedLivePullRequest(api, pullNumber, liveContext)
    await setAutoMerge(api, beforeQuarantine, false)
    return {
      body: pullRequest.body || '',
      enableAutoMerge: false,
      labels: (pullRequest.labels || []).map(({ name }) => name),
      major: false,
      matchedAlerts: [],
      pullNumber,
      quarantined: true,
      severity: ''
    }
  }

  const commits = await paginated(api, `/repos/${repository}/pulls/${pullNumber}/commits`, pullRequest.commits)
  invariant(commits.length === 1, 'Only a single signed Dependabot commit is eligible for normalization')
  const commit = commits[0]
  invariant(commit?.sha === pullRequest.head.sha, 'Verified commit does not equal the pull request head')
  invariant(commit?.author?.login === DEPENDABOT, `Commit ${commit?.sha || 'unknown'} is not authored by Dependabot`)
  invariant(commit?.commit?.verification?.verified === true, `Commit ${commit?.sha || 'unknown'} does not have a verified signature`)

  const dependencies = parseDependabotMetadata(commit.commit.message)
  const changedFiles = (await paginated(api, `/repos/${repository}/pulls/${pullNumber}/files`, pullRequest.changed_files)).map(({ filename }) => filename)
  const alerts = await paginated(api, `/repos/${repository}/dependabot/alerts?state=open`)
  const ecosystem = pullRequest.head.ref.split('/')[1] || ''
  const planInputs = {
    dependencies,
    alerts,
    changedFiles,
    ecosystem,
    headSha: pullRequest.head.sha
  }
  let plan = makeNormalizationPlan({ ...planInputs, existingBody: pullRequest.body || '' })

  // First write: all run, repository, PR, SHA, author, and signed-commit checks
  // above have succeeded against the live GitHub API.
  await getVerifiedLivePullRequest(api, pullNumber, liveContext)
  for (const label of plan.labels) await ensureLabel(api, repository, label)
  const beforeBody = await getVerifiedLivePullRequest(api, pullNumber, liveContext)
  plan = makeNormalizationPlan({ ...planInputs, existingBody: beforeBody.body || '' })
  await api.request(`/repos/${repository}/pulls/${pullNumber}`, {
    method: 'PATCH',
    body: { body: plan.body }
  })
  const beforeLabels = await getVerifiedLivePullRequest(api, pullNumber, liveContext)
  const existingLabels = (beforeLabels.labels || []).map(({ name }) => name)
  const labels = [...new Set([
    ...existingLabels.filter((name) => !MANAGED_LABELS.has(name)),
    ...plan.labels
  ])].sort()
  await api.request(`/repos/${repository}/issues/${pullNumber}/labels`, {
    method: 'PUT',
    body: { labels }
  })
  const beforeAutoMerge = await getVerifiedLivePullRequest(api, pullNumber, liveContext)
  await setAutoMerge(api, beforeAutoMerge, plan.enableAutoMerge)

  return { ...plan, labels, pullNumber }
}

async function main () {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const repository = process.env.GITHUB_REPOSITORY
  invariant(repository, 'GITHUB_REPOSITORY is required')
  const api = new GitHubApi({ token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL })
  const result = await normalizeDependabot({ event, repository, api })
  const summary = [
    '# Dependabot normalization',
    '',
    `Pull request: #${result.pullNumber}`,
    `Severity: ${result.severity || 'unmatched / requires triage'}`,
    `Major update: ${result.major}`,
    `Auto-merge enabled: ${result.enableAutoMerge}`,
    `Defensive quarantine: ${Boolean(result.quarantined)}`,
    `Managed labels: ${result.labels.join(', ')}`
  ].join('\n')
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Dependabot normalization failed: ${error.message}`)
    process.exitCode = 1
  })
}
