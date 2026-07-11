import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  allGoModuleNames,
  deprecatedPnpmPackages,
  directGoModuleNames,
  isAbandonedRenovatePullRequest,
  isPendingReleasePullRequest,
  lockedDirectPnpmVersions,
  openCloudWebCompatibilityFindings,
  pnpmUpdateSummary,
  requiredCheckSummary,
  replacementLeadLabel,
  safeReportText,
  suggestedReplacementNames
} from './weekly-report-lib.mjs'

const outputPath = process.argv[2] || 'weekly-maintenance-report.md'
const repository = process.env.GITHUB_REPOSITORY
if (!repository) throw new Error('GITHUB_REPOSITORY is required')
const releasePreflight = process.env.RELEASE_PREFLIGHT === 'true'

const run = (command, args, options = {}) => {
  const { acceptStdoutOnFailure = false, ...execOptions } = options
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
      ...execOptions
    }).trim()
  } catch (error) {
    const stdout = String(error.stdout || '').trim()
    // `pnpm outdated` deliberately exits non-zero when updates exist. Other
    // commands must not be allowed to disguise an API/registry error with a
    // partial stdout payload.
    if (acceptStdoutOnFailure && stdout) return stdout
    return { error: String(error.stderr || error.message || error) }
  }
}

const json = (command, args, options) => {
  const value = run(command, args, options)
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value || 'null')
  } catch (error) {
    return { error: `Invalid JSON from ${command}: ${error.message}` }
  }
}

const compatibility = readFileSync('compatibility.lock.yaml', 'utf8')
const lockedOpenCloud = compatibility.match(/stable_release: "([^"]+)"/)?.[1] || 'unknown'
const approvedReplacements = new Map(
  [...compatibility.matchAll(/^  "([^"]+)":\s*"([^"]+)"\s*$/gm)].map((match) => [match[1], match[2]])
)

const isNpmPackageName = (value) => /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i.test(value)
const isGitHubRepository = (value) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value)

const npmCandidate = (name, reason) => {
  if (!isNpmPackageName(name)) return null
  const info = json('npm', ['view', name, 'version', 'deprecated', 'repository.url', '--json'])
  const version = typeof info === 'string' ? info : info?.version
  if (info?.error || !version || info?.deprecated) return null
  return {
    name,
    version: String(version),
    url: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
    reason
  }
}

const discoverNpmCandidates = (dependency, note, approved) => {
  const names = []
  if (approved && isNpmPackageName(approved)) names.push({ name: approved, reason: 'approved replacement' })
  for (const name of suggestedReplacementNames(note, dependency)) {
    if (isNpmPackageName(name)) names.push({ name, reason: 'explicit deprecation hint' })
  }

  const search = json('npm', ['search', dependency, '--json', '--searchlimit', '10'])
  if (search?.error) return { candidates: [], failure: `${dependency}: npm replacement search failed` }
  if (Array.isArray(search)) {
    const tokens = dependency.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['node', 'package'].includes(token))
    for (const item of search) {
      const searchable = `${item?.name || ''} ${item?.description || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const relevant = tokens.length === 0 || tokens.some((token) => searchable.includes(token.replace(/[^a-z0-9]+/g, '')))
      if (relevant && item?.name && item.name !== dependency) names.push({ name: item.name, reason: 'untrusted registry search lead' })
    }
  }

  const candidates = []
  const seen = new Set([dependency.toLowerCase()])
  for (const entry of names) {
    const normalized = entry.name.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const candidate = npmCandidate(entry.name, entry.reason)
    if (candidate) candidates.push(candidate)
    if (candidates.length === 3) break
  }
  return { candidates, failure: '' }
}

const githubCandidate = (info, reason) => {
  if (!info?.full_name || info.archived || info.disabled || !info.default_branch) return null
  const pushedAt = Date.parse(info.pushed_at || '')
  if (Number.isFinite(pushedAt) && pushedAt < Date.now() - 366 * 24 * 60 * 60 * 1000) return null
  const release = json('gh', ['api', `repos/${info.full_name}/releases/latest`])
  let version = release?.tag_name || ''
  if (!version) {
    const tags = json('gh', ['api', `repos/${info.full_name}/tags?per_page=1`])
    if (Array.isArray(tags)) version = tags[0]?.name || ''
  }
  return {
    name: `github.com/${info.full_name}`,
    version: version || `active ${info.default_branch}`,
    url: info.html_url,
    reason
  }
}

const discoverGitHubCandidates = (dependency, note, approved) => {
  const original = dependency.replace(/^github\.com\//, '').replace(/\/v\d+$/, '')
  if (!isGitHubRepository(original)) return { candidates: [], failure: '' }
  const candidates = []
  const seen = new Set([original.toLowerCase()])

  const addRepository = (name, reason) => {
    const normalized = String(name || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/i, '')
    if (!isGitHubRepository(normalized) || seen.has(normalized.toLowerCase()) || candidates.length >= 3) return
    seen.add(normalized.toLowerCase())
    const info = json('gh', ['api', `repos/${normalized}`])
    if (!info?.error) {
      const candidate = githubCandidate(info, reason)
      if (candidate) candidates.push(candidate)
    }
  }

  if (approved) addRepository(approved.replace(/^github\.com\//, ''), 'approved replacement')
  for (const name of suggestedReplacementNames(note, original)) addRepository(name, 'explicit lifecycle hint')

  const forks = json('gh', ['api', '--method', 'GET', `repos/${original}/forks`, '-f', 'sort=stargazers', '-f', 'per_page=10'])
  if (Array.isArray(forks)) {
    for (const info of forks) {
      if (candidates.length >= 3 || seen.has(String(info?.full_name || '').toLowerCase())) continue
      seen.add(String(info.full_name || '').toLowerCase())
      const candidate = githubCandidate(info, 'untrusted heuristic active fork')
      if (candidate) candidates.push(candidate)
    }
  }

  if (candidates.length < 3) {
    const basename = original.split('/').at(-1)
    const search = json('gh', [
      'api', '--method', 'GET', 'search/repositories',
      '-f', `q=${basename} in:name,description archived:false fork:false`,
      '-f', 'sort=stars', '-f', 'order=desc', '-f', 'per_page=10'
    ])
    if (search?.error) return { candidates, failure: `${dependency}: GitHub replacement search failed` }
    for (const info of search?.items || []) {
      if (candidates.length >= 3 || seen.has(String(info?.full_name || '').toLowerCase())) continue
      seen.add(String(info.full_name || '').toLowerCase())
      const candidate = githubCandidate(info, 'untrusted heuristic repository search lead')
      if (candidate) candidates.push(candidate)
    }
  }

  return { candidates, failure: '' }
}

const latestOpenCloud = json('gh', ['api', 'repos/opencloud-eu/opencloud/releases/latest'])
const latestTag = latestOpenCloud?.tag_name || 'lookup-failed'
const upstreamChanged = latestTag !== 'lookup-failed' && latestTag !== lockedOpenCloud
const configurationBlockers = []
if (!releasePreflight && process.env.RENOVATE_CONFIGURED !== 'true') {
  configurationBlockers.push('RENOVATE_TOKEN is not configured; automatic dependency PR creation is disabled')
}
if (latestTag === 'lookup-failed') {
  configurationBlockers.push('The latest formal OpenCloud release could not be resolved')
} else if (upstreamChanged) {
  configurationBlockers.push(`OpenCloud ${latestTag} is available; merge the grouped compatibility target and image-digest update before release`)
}

const lockedImage = compatibility.match(/^  image: "([^"]+)"$/m)?.[1] || ''
const expectedImageVersion = lockedOpenCloud.replace(/^v/, '')
if (!new RegExp(`:${expectedImageVersion.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`).test(lockedImage)) {
  configurationBlockers.push('OpenCloud image must match stable_release and include an exact sha256 digest')
}

let upstreamGo = 'lookup-failed'
let upstreamWeb = 'lookup-failed'
let upstreamNode = 'lookup-failed'
let upstreamPnpm = 'lookup-failed'
let upstreamWebPackageVersion = 'lookup-failed'
if (latestTag !== 'lookup-failed') {
  const upstreamGoMod = run('gh', [
    'api', '-H', 'Accept: application/vnd.github.raw+json',
    `repos/opencloud-eu/opencloud/contents/go.mod?ref=${encodeURIComponent(latestTag)}`
  ])
  const upstreamWebMakefile = run('gh', [
    'api', '-H', 'Accept: application/vnd.github.raw+json',
    `repos/opencloud-eu/opencloud/contents/services/web/Makefile?ref=${encodeURIComponent(latestTag)}`
  ])
  if (typeof upstreamGoMod === 'string') {
    upstreamGo = upstreamGoMod.match(/^go\s+(\S+)/m)?.[1] || 'lookup-failed'
  }
  if (typeof upstreamWebMakefile === 'string') {
    const versions = [...upstreamWebMakefile.matchAll(/^WEB_ASSETS_VERSION\s*=\s*(\S+)\s*$/gm)]
    upstreamWeb = versions.length === 1 ? versions[0][1] : 'lookup-failed'
  }
  if (upstreamWeb !== 'lookup-failed') {
    const upstreamWebPackage = run('gh', [
      'api', '-H', 'Accept: application/vnd.github.raw+json',
      `repos/opencloud-eu/web/contents/package.json?ref=${encodeURIComponent(upstreamWeb)}`
    ])
    if (typeof upstreamWebPackage === 'string') {
      try {
        const packageJson = JSON.parse(upstreamWebPackage)
        upstreamNode = packageJson?.volta?.node || 'lookup-failed'
        upstreamPnpm = String(packageJson?.packageManager || '').match(/^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1] || 'lookup-failed'
        upstreamWebPackageVersion = packageJson?.version || 'lookup-failed'
      } catch {
        upstreamNode = 'lookup-failed'
        upstreamPnpm = 'lookup-failed'
        upstreamWebPackageVersion = 'lookup-failed'
      }
    }
  }
}
if ([upstreamGo, upstreamWeb, upstreamNode, upstreamPnpm, upstreamWebPackageVersion].includes('lookup-failed')) {
  configurationBlockers.push('OpenCloud Go or embedded Web version, Node, and pnpm compatibility metadata could not be resolved')
}
const lockedGoMinimum = compatibility.match(/^  go_module_minimum: "([^"]+)"$/m)?.[1] || ''
const lockedNode = compatibility.match(/^  node: "([^"]+)"$/m)?.[1] || ''
const lockedPnpm = compatibility.match(/^  pnpm: "([^"]+)"$/m)?.[1] || ''
const approvedWebMajor = compatibility.match(/^  embedded_web_major: "([^"]+)"$/m)?.[1] || ''
if (upstreamGo !== 'lookup-failed' && upstreamGo !== lockedGoMinimum) {
  configurationBlockers.push(`OpenCloud requires Go ${upstreamGo}, but go_module_minimum is ${lockedGoMinimum || 'missing'}`)
}
if (![upstreamWeb, upstreamNode, upstreamPnpm, upstreamWebPackageVersion].includes('lookup-failed')) {
  configurationBlockers.push(...openCloudWebCompatibilityFindings({
    approvedWebMajor,
    selectedNode: lockedNode,
    selectedPnpm: lockedPnpm,
    upstreamNode,
    upstreamPackageVersion: upstreamWebPackageVersion,
    upstreamPnpm,
    upstreamWeb,
  }))
}

const pullRequests = releasePreflight ? [] : json('gh', [
  'pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
  '--json', 'number,title,url,isDraft,updatedAt,labels,author,headRefName,statusCheckRollup'
])
if (!releasePreflight && Array.isArray(pullRequests)) {
  const pendingReleasePRs = pullRequests.filter(isPendingReleasePullRequest)
  if (pendingReleasePRs.length > 0) {
    configurationBlockers.push(`Release-bearing PRs are still open: ${pendingReleasePRs.map((pr) => `#${pr.number}`).join(', ')}`)
  }
  const unroutedDependencyPRs = pullRequests.filter((pr) => {
    const labels = new Set(pr.labels.map(({ name }) => name))
    const automatedBranch = /^(?:renovate|dependabot)\//.test(pr.headRefName || '')
    const routed = ['release:weekly', 'security:high', 'security:critical', 'roadmap:required']
      .some((label) => labels.has(label))
    return automatedBranch && !isAbandonedRenovatePullRequest(pr) && labels.has('dependencies') && !routed
  })
  if (unroutedDependencyPRs.length > 0) {
    configurationBlockers.push(`Automated dependency PRs have no release or roadmap route: ${unroutedDependencyPRs.map((pr) => `#${pr.number}`).join(', ')}`)
  }
} else if (!releasePreflight) {
  configurationBlockers.push('Open pull requests could not be enumerated')
}

const goMod = readFileSync('file-archiver-service/go.mod', 'utf8')
const lockedGoTools = [...compatibility.matchAll(
  /# renovate: datasource=go depName=(\S+)\n\s+[a-z0-9_]+: "([^"]+)"/g
)].map((match) => ({ module: match[1], version: match[2] }))
const directGoModules = new Set(directGoModuleNames(goMod))
const goModuleQueries = new Map(allGoModuleNames(goMod).map((module) => [module, module]))
for (const { module, version } of lockedGoTools) {
  goModuleQueries.set(module, `${module}@${version}`)
}
const goModules = [...goModuleQueries.keys()]
const packageJson = JSON.parse(readFileSync('web-app-file-archiver/package.json', 'utf8'))
const pnpmLockfile = readFileSync('web-app-file-archiver/pnpm-lock.yaml', 'utf8')
const npmDependencies = Object.keys({
  ...(packageJson.dependencies || {}),
  ...(packageJson.devDependencies || {})
})
const lifecycleFailures = []
const npmGithubRepositories = []
for (const dependency of npmDependencies) {
  const repositoryInfo = json('npm', ['view', dependency, 'repository.url', '--json'])
  if (repositoryInfo?.error) {
    lifecycleFailures.push(`${dependency}: npm source repository lookup failed`)
    continue
  }
  const repositoryUrl = typeof repositoryInfo === 'string' ? repositoryInfo : repositoryInfo?.url
  const match = repositoryUrl?.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i)
  if (match) npmGithubRepositories.push(`${match[1]}/${match[2]}`)
}
const githubRepositories = [...new Set([...goModules.filter((module) => module.startsWith('github.com/')).map((module) => {
  const parts = module.split('/')
  return `${parts[1]}/${parts[2]}`
}), ...npmGithubRepositories])]

const archived = []
const githubFailures = []
for (const repo of githubRepositories) {
  const info = json('gh', ['api', `repos/${repo}`])
  if (info?.error) {
    githubFailures.push(`${repo}: ${info.error.split('\n')[0]}`)
    continue
  }
  if (info.archived || info.disabled) {
    archived.push({
      dependency: `github.com/${repo}`,
      url: info.html_url,
      archived: Boolean(info.archived),
      disabled: Boolean(info.disabled),
      replacement: approvedReplacements.get(`github.com/${repo}`) || ''
    })
  }
}

const transitiveDeprecatedNpm = deprecatedPnpmPackages(pnpmLockfile)
  .filter(({ dependency }) => !npmDependencies.includes(dependency))
const replacementDiscoveryNotes = []

const directGoUpdates = []
for (const module of goModules) {
  const info = json('go', ['list', '-m', '-u', '-json', goModuleQueries.get(module)], {
    cwd: 'file-archiver-service'
  })
  if (info?.error) {
    lifecycleFailures.push(`${module}: Go module lookup failed`)
    continue
  }
  if (info?.Update?.Version && (directGoModules.has(module) || lockedGoTools.some((tool) => tool.module === module))) {
    directGoUpdates.push(`${module}: ${info.Version} → ${info.Update.Version}`)
  }
  if (info?.Retracted?.length) {
    archived.push({
      dependency: module,
      url: '',
      archived: false,
      disabled: false,
      replacement: approvedReplacements.get(module) || approvedReplacements.get(module.replace(/\/v\d+$/, '')) || '',
      note: `current version retracted: ${info.Retracted.join('; ')}`
    })
  }
  if (info?.Deprecated) {
    archived.push({
      dependency: module,
      url: '',
      archived: false,
      disabled: false,
      replacement: approvedReplacements.get(module) || approvedReplacements.get(module.replace(/\/v\d+$/, '')) || '',
      note: `module deprecated: ${info.Deprecated}`
    })
  }
}

const deprecatedNpm = []
let npmUpdates = []
const outdatedInfo = json('pnpm', ['outdated', '--format', 'json'], {
  cwd: 'web-app-file-archiver',
  acceptStdoutOnFailure: true
})
if (outdatedInfo?.error) {
  lifecycleFailures.push('pnpm outdated registry resolution failed')
} else if (outdatedInfo && typeof outdatedInfo === 'object') {
  const summary = pnpmUpdateSummary(outdatedInfo)
  npmUpdates = summary.updates
  lifecycleFailures.push(...summary.failures)
}

const resolvedNpmVersions = lockedDirectPnpmVersions(pnpmLockfile)

for (const dependency of npmDependencies) {
  const resolvedVersion = resolvedNpmVersions.get(dependency)
  if (!resolvedVersion) {
    lifecycleFailures.push(`${dependency}: locked npm version could not be resolved`)
    continue
  }
  const deprecatedInfo = json('npm', ['view', `${dependency}@${resolvedVersion}`, 'deprecated', '--json'])
  if (deprecatedInfo?.error) lifecycleFailures.push(`${dependency}: npm deprecation lookup failed`)
  const deprecation = typeof deprecatedInfo === 'string' ? deprecatedInfo : deprecatedInfo?.deprecated
  if (deprecation) {
    deprecatedNpm.push({
      dependency,
      version: resolvedVersion,
      note: String(deprecation),
      replacement: approvedReplacements.get(dependency) || ''
    })
  }
}

for (const item of archived) {
  const discovery = item.dependency.startsWith('github.com/')
    ? discoverGitHubCandidates(item.dependency, item.note || '', item.replacement)
    : { candidates: [], failure: '' }
  item.candidates = discovery.candidates
  if (discovery.failure) lifecycleFailures.push(discovery.failure)
}
for (const item of deprecatedNpm) {
  const discovery = discoverNpmCandidates(item.dependency, item.note, item.replacement)
  item.candidates = discovery.candidates
  if (discovery.failure) lifecycleFailures.push(discovery.failure)
}
for (const item of transitiveDeprecatedNpm) {
  const samePackage = npmCandidate(item.dependency, 'newer non-deprecated release of the same package')
  const discovery = samePackage && samePackage.version !== item.version
    ? { candidates: [samePackage], failure: '' }
    : discoverNpmCandidates(item.dependency, item.note, '')
  item.candidates = discovery.candidates
  if (discovery.failure) replacementDiscoveryNotes.push(discovery.failure)
}

const unresolved = [
  ...archived,
  ...deprecatedNpm,
  ...configurationBlockers.map((note) => ({ dependency: 'automation configuration', note })),
  ...githubFailures.map((note) => ({ dependency: 'GitHub lifecycle lookup', note })),
  ...lifecycleFailures.map((note) => ({ dependency: 'registry lifecycle lookup', note }))
]

const lines = [
  '# Weekly maintenance report',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Repository: ${repository}`,
  `Tracked OpenCloud stable: ${lockedOpenCloud}`,
  `Latest OpenCloud stable: ${latestTag}`,
  `Latest OpenCloud required Go: ${upstreamGo}`,
  `Latest OpenCloud embedded Web: ${upstreamWeb}`,
  `Embedded OpenCloud Web Volta Node baseline: ${upstreamNode}`,
  `Embedded OpenCloud Web pnpm baseline: ${upstreamPnpm}`,
  `OpenCloud update detected: ${upstreamChanged ? 'yes' : 'no'}`,
  `Unresolved blockers: ${unresolved.length}`,
  '',
  '## Open pull requests',
  ''
]

if (Array.isArray(pullRequests) && pullRequests.length > 0) {
  for (const pr of pullRequests) {
    const labels = pr.labels.map(({ name }) => name).join(', ') || 'none'
    const checks = requiredCheckSummary(pr.statusCheckRollup)
    lines.push(`- [#${pr.number} ${pr.title}](${pr.url}) — labels: ${labels}; draft: ${pr.isDraft}; ${checks}`)
  }
} else {
  lines.push('- None')
}

lines.push('', '## Direct dependency updates', '')
for (const item of [...directGoUpdates, ...npmUpdates]) lines.push(`- ${item}`)
if (directGoUpdates.length + npmUpdates.length === 0) lines.push('- None detected')

lines.push('', '## Archived, disabled, retracted, or deprecated dependencies', '')
for (const item of [...archived, ...deprecatedNpm]) {
  const replacement = item.replacement
    ? `approved replacement: ${safeReportText(item.replacement)}`
    : 'no approved replacement'
  const link = item.url ? `[${item.dependency}](${item.url})` : item.dependency
  const version = item.version ? `@${item.version}` : ''
  const note = safeReportText(item.note || (item.archived ? 'repository archived' : 'repository disabled'))
  lines.push(`- ${link}${version}: ${note} — ${replacement}`)
  if (item.candidates?.length) {
    for (const candidate of item.candidates) {
      lines.push(`  - ${replacementLeadLabel(candidate.reason)} (${safeReportText(candidate.reason)}): [${safeReportText(candidate.name)}](${candidate.url}) @ ${safeReportText(candidate.version)}`)
    }
  } else {
    lines.push('  - **No viable replacement candidate was found automatically.**')
  }
  lines.push('  - Migration remains blocked until a replacement is approved, implemented, and passes full acceptance.')
}
if (archived.length + deprecatedNpm.length === 0) lines.push('- None detected')

lines.push('', '## Deprecated transitive npm packages', '')
if (transitiveDeprecatedNpm.length > 0) {
  lines.push('- These are not shipped as declared direct dependencies. They are reported for parent-package maintenance; vulnerability reachability is enforced separately by `pnpm audit` and release scanning.')
  for (const item of transitiveDeprecatedNpm) {
    lines.push(`- ${safeReportText(item.dependency)}@${safeReportText(item.version)}: ${safeReportText(item.note)}`)
    if (item.candidates?.length) {
      for (const candidate of item.candidates) {
        lines.push(`  - ${replacementLeadLabel(candidate.reason)} (${safeReportText(candidate.reason)}): [${safeReportText(candidate.name)}](${candidate.url}) @ ${safeReportText(candidate.version)}`)
      }
    } else {
      lines.push('  - No viable replacement candidate was found automatically; update or replace the owning direct dependency.')
    }
  }
} else {
  lines.push('- None detected')
}

if (replacementDiscoveryNotes.length > 0) {
  lines.push('', '## Incomplete transitive replacement discovery', '', ...replacementDiscoveryNotes.map((item) => `- ${safeReportText(item)}`))
}

lines.push('', '## Automation configuration blockers', '')
if (configurationBlockers.length > 0) {
  lines.push(...configurationBlockers.map((item) => `- **${item}**`))
} else {
  lines.push('- None')
}

if (githubFailures.length > 0) {
  lines.push('', '## Incomplete GitHub checks', '', ...githubFailures.map((item) => `- ${item}`))
}
if (lifecycleFailures.length > 0) {
  lines.push('', '## Incomplete registry checks', '', ...lifecycleFailures.map((item) => `- ${item}`))
}

lines.push(
  '',
  '## Policy',
  '',
  '- Non-breaking dependency updates are grouped into the weekly release PR by Renovate.',
  '- Major/breaking updates stay manual and require a roadmap decision.',
  '- High/Critical runtime fixes use trusted severity labels and release immediately after merge and full acceptance.',
  '- Any direct or locked archived/deprecated/retracted dependency blocks automatic release until migrated; a missing approved replacement also requires a maintainer decision.',
  '- Deprecated transitive npm packages are reported with clearly classified verified candidates or untrusted search leads; they block only when vulnerability or acceptance gates find reachable risk.'
)

writeFileSync(outputPath, `${lines.join('\n')}\n`)
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_OUTPUT, `blockers_clear=${unresolved.length === 0}\n`)
}
