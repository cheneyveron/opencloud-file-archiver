import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

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
    upstreamWeb = upstreamWebMakefile.match(/^WEB_ASSETS_VERSION\s*=\s*(\S+)/m)?.[1] || 'lookup-failed'
  }
  if (upstreamWeb !== 'lookup-failed') {
    const upstreamWebPackage = run('gh', [
      'api', '-H', 'Accept: application/vnd.github.raw+json',
      `repos/opencloud-eu/web/contents/package.json?ref=${encodeURIComponent(upstreamWeb)}`
    ])
    if (typeof upstreamWebPackage === 'string') {
      try {
        upstreamNode = JSON.parse(upstreamWebPackage)?.volta?.node || 'lookup-failed'
      } catch {
        upstreamNode = 'lookup-failed'
      }
    }
  }
}
if (upstreamGo === 'lookup-failed' || upstreamWeb === 'lookup-failed' || upstreamNode === 'lookup-failed') {
  configurationBlockers.push('OpenCloud Go, embedded Web, or Web Node compatibility metadata could not be resolved')
}
const lockedGoMinimum = compatibility.match(/^  go_module_minimum: "([^"]+)"$/m)?.[1] || ''
const lockedNode = compatibility.match(/^  node: "([^"]+)"$/m)?.[1] || ''
if (upstreamGo !== 'lookup-failed' && upstreamGo !== lockedGoMinimum) {
  configurationBlockers.push(`OpenCloud requires Go ${upstreamGo}, but go_module_minimum is ${lockedGoMinimum || 'missing'}`)
}
if (upstreamNode !== 'lookup-failed' && upstreamNode !== lockedNode) {
  configurationBlockers.push(`Embedded OpenCloud Web requires Node ${upstreamNode}, but toolchains.node is ${lockedNode || 'missing'}`)
}

const pullRequests = releasePreflight ? [] : json('gh', [
  'pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
  '--json', 'number,title,url,isDraft,updatedAt,labels,author'
])
if (!releasePreflight && Array.isArray(pullRequests)) {
  const pendingReleasePRs = pullRequests.filter((pr) =>
    pr.labels.some(({ name }) => ['release:weekly', 'security:high', 'security:critical'].includes(name))
  )
  if (pendingReleasePRs.length > 0) {
    configurationBlockers.push(`Release-bearing PRs are still open: ${pendingReleasePRs.map((pr) => `#${pr.number}`).join(', ')}`)
  }
} else if (!releasePreflight) {
  configurationBlockers.push('Open pull requests could not be enumerated')
}

const goMod = readFileSync('file-archiver-service/go.mod', 'utf8')
const lockedGoTools = [...compatibility.matchAll(
  /# renovate: datasource=go depName=(\S+)\n\s+[a-z0-9_]+: "([^"]+)"/g
)].map((match) => ({ module: match[1], version: match[2] }))
const goModuleQueries = new Map(
  [...goMod.matchAll(/^\s*([^\s]+)\s+v[^\s]+/gm)].map((match) => [match[1], match[1]])
)
for (const { module, version } of lockedGoTools) {
  goModuleQueries.set(module, `${module}@${version}`)
}
const goModules = [...goModuleQueries.keys()]
const packageJson = JSON.parse(readFileSync('web-app-file-archiver/package.json', 'utf8'))
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

const directGoUpdates = []
for (const module of goModules) {
  const info = json('go', ['list', '-m', '-u', '-json', goModuleQueries.get(module)], {
    cwd: 'file-archiver-service'
  })
  if (info?.error) {
    lifecycleFailures.push(`${module}: Go module lookup failed`)
    continue
  }
  if (info?.Update?.Version) {
    directGoUpdates.push(`${module}: ${info.Version} → ${info.Update.Version}`)
  }
  if (info?.Retracted?.length) {
    archived.push({
      dependency: module,
      url: '',
      archived: false,
      disabled: false,
      replacement: approvedReplacements.get(module) || '',
      note: `current version retracted: ${info.Retracted.join('; ')}`
    })
  }
  if (info?.Deprecated) {
    archived.push({
      dependency: module,
      url: '',
      archived: false,
      disabled: false,
      replacement: approvedReplacements.get(module) || '',
      note: `module deprecated: ${info.Deprecated}`
    })
  }
}

const deprecatedNpm = []
const npmUpdates = []
const outdatedInfo = json('pnpm', ['outdated', '--format', 'json'], {
  cwd: 'web-app-file-archiver',
  acceptStdoutOnFailure: true
})
if (outdatedInfo?.error) {
  lifecycleFailures.push('pnpm outdated registry resolution failed')
} else if (outdatedInfo && typeof outdatedInfo === 'object') {
  for (const [dependency, info] of Object.entries(outdatedInfo)) {
    npmUpdates.push(`${dependency}: ${info.current || 'unknown'} → ${info.latest || 'unknown'}`)
  }
}

const installedInfo = json(
  'pnpm',
  ['list', '--depth', '0', '--json', '--lockfile-only'],
  { cwd: 'web-app-file-archiver' }
)
const resolvedNpmVersions = new Map()
if (Array.isArray(installedInfo) && installedInfo.length > 0) {
  for (const project of installedInfo) {
    const directDependencies = {
      ...(project.dependencies || {}),
      ...(project.devDependencies || {}),
      ...(project.optionalDependencies || {})
    }
    for (const [dependency, info] of Object.entries(directDependencies)) {
      const version = typeof info === 'string' ? info : info?.version
      if (version) resolvedNpmVersions.set(dependency, version)
    }
  }
} else {
  lifecycleFailures.push('pnpm could not enumerate locked direct dependency versions')
}

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
  `Embedded OpenCloud Web required Node: ${upstreamNode}`,
  `OpenCloud update detected: ${upstreamChanged ? 'yes' : 'no'}`,
  `Unresolved blockers: ${unresolved.length}`,
  '',
  '## Open pull requests',
  ''
]

if (Array.isArray(pullRequests) && pullRequests.length > 0) {
  for (const pr of pullRequests) {
    const labels = pr.labels.map(({ name }) => name).join(', ') || 'none'
    lines.push(`- [#${pr.number} ${pr.title}](${pr.url}) — labels: ${labels}; draft: ${pr.isDraft}`)
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
    ? `approved replacement: ${item.replacement}; migration is still required before release`
    : '**no approved replacement; maintainer decision required**'
  const link = item.url ? `[${item.dependency}](${item.url})` : item.dependency
  const version = item.version ? `@${item.version}` : ''
  lines.push(`- ${link}${version}: ${item.note || (item.archived ? 'repository archived' : 'repository disabled')} — ${replacement}`)
}
if (archived.length + deprecatedNpm.length === 0) lines.push('- None detected')

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
  '- Any archived/deprecated/retracted dependency blocks automatic release until migrated; a missing approved replacement also requires a maintainer decision.'
)

writeFileSync(outputPath, `${lines.join('\n')}\n`)
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_OUTPUT, `blockers_clear=${unresolved.length === 0}\n`)
}
