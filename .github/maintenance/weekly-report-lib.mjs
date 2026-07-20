export function allGoModuleNames(goMod) {
  const modules = []
  for (const line of String(goMod).split('\n')) {
    const match = line.match(/^\s*([^\s()]+)\s+v[^\s]+(?:\s+\/\/\s*indirect)?\s*$/)
    if (match) modules.push(match[1])
  }
  return [...new Set(modules)]
}

export function directGoModuleNames(goMod) {
  const indirect = new Set(
    String(goMod)
      .split('\n')
      .filter((line) => /\/\/\s*indirect\s*$/.test(line))
      .map((line) => line.trim().split(/\s+/, 1)[0]),
  )
  return allGoModuleNames(goMod).filter((module) => !indirect.has(module))
}

export function pnpmUpdateSummary(outdatedInfo) {
  const failures = []
  const updates = []

  for (const [dependency, info] of Object.entries(outdatedInfo || {})) {
    const baseline = info?.wanted || info?.current
    const latest = info?.latest
    if (!baseline || !latest) {
      failures.push(`${dependency}: pnpm omitted the locked or latest version`)
      continue
    }
    if (baseline !== latest) updates.push(`${dependency}: ${baseline} → ${latest}`)
  }

  return { failures, updates }
}

function stableVersionTriplet(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  return match ? match.slice(1).map(BigInt) : null
}

export function latestDeployableStableDockerTag(records) {
  let latest = null
  for (const record of Array.isArray(records) ? records : []) {
    const version = stableVersionTriplet(record?.name)
    if (!version || !/^sha256:[a-f0-9]{64}$/.test(String(record?.digest || ''))) continue
    const differingIndex = latest && version.findIndex((part, index) => part !== latest.version[index])
    if (!latest || (differingIndex >= 0 && version[differingIndex] > latest.version[differingIndex])) {
      latest = { name: record.name, version }
    }
  }
  return latest ? `v${latest.name}` : ''
}

export function isSameMajorStableVersionAtLeast(baselineVersion, selectedVersion) {
  const baseline = stableVersionTriplet(baselineVersion)
  const selected = stableVersionTriplet(selectedVersion)
  if (!baseline || !selected || selected[0] !== baseline[0]) return false

  for (let index = 1; index < baseline.length; index += 1) {
    if (selected[index] !== baseline[index]) return selected[index] > baseline[index]
  }
  return true
}

export function openCloudWebCompatibilityFindings({
  approvedWebMajor,
  selectedNode,
  selectedPnpm,
  upstreamNode,
  upstreamPackageVersion,
  upstreamPnpm,
  upstreamWeb,
}) {
  const findings = []
  const web = String(upstreamWeb || '').match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!web) {
    findings.push(`OpenCloud embedded Web ${upstreamWeb || 'missing'} is not a stable vX.Y.Z release`)
  } else if (!/^(?:0|[1-9]\d*)$/.test(String(approvedWebMajor || '')) ||
             web[1] !== String(approvedWebMajor)) {
    findings.push(`OpenCloud embedded Web major ${web[1]} is outside approved major ${approvedWebMajor || 'missing'}; a roadmap decision is required`)
  }
  if (web && upstreamPackageVersion !== upstreamWeb.slice(1)) {
    findings.push(`Embedded OpenCloud Web package version ${upstreamPackageVersion || 'missing'} does not match ${upstreamWeb}`)
  }

  if (!isSameMajorStableVersionAtLeast(upstreamNode, selectedNode)) {
    findings.push(`Embedded OpenCloud Web uses Volta Node baseline ${upstreamNode || 'missing'}; toolchains.node must be no older in the same major, but is ${selectedNode || 'missing'}`)
  }
  if (!isSameMajorStableVersionAtLeast(upstreamPnpm, selectedPnpm)) {
    findings.push(`Embedded OpenCloud Web uses pnpm baseline ${upstreamPnpm || 'missing'}; toolchains.pnpm must be no older in the same major, but is ${selectedPnpm || 'missing'}`)
  }
  return findings
}

export function webMajorAllowanceChangeFindings({
  automatedAuthor,
  currentMajor,
  labels = [],
  proposedMajor,
}) {
  if (currentMajor === proposedMajor) return []
  const labelSet = new Set(labels)
  const findings = []
  if (automatedAuthor) {
    findings.push('Automated PRs cannot change opencloud.embedded_web_major; use an independent human roadmap decision')
  }
  if (!labelSet.has('roadmap:required')) {
    findings.push('Changing opencloud.embedded_web_major requires a roadmap:required decision')
  }
  if (['release:weekly', 'security:high', 'security:critical'].some((label) => labelSet.has(label))) {
    findings.push('An embedded Web major allowance change cannot use an automatic release route')
  }
  return findings
}

export function isAutomatedDependencyPullRequest({ authorLogin, authorType, headRef }) {
  return authorType === 'Bot' ||
    /\[bot\]$/.test(String(authorLogin || '')) ||
    /^(?:renovate|dependabot)\//.test(String(headRef || ''))
}

export function deprecatedPnpmPackages(lockfile) {
  const findings = []
  let inPackages = false
  let current = ''
  for (const line of String(lockfile).split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages && /^snapshots:\s*$/.test(line)) break
    if (!inPackages) continue
    const packageLine = line.match(/^  (.+):\s*$/)
    if (packageLine) {
      current = packageLine[1].replace(/^['"]|['"]$/g, '').replace(/\(.+\)$/, '')
      continue
    }
    const deprecated = line.match(/^    deprecated:\s*(.+?)\s*$/)
    if (!deprecated || !current) continue
    const separator = current.lastIndexOf('@')
    if (separator <= 0) continue
    findings.push({
      dependency: current.slice(0, separator),
      version: current.slice(separator + 1),
      note: deprecated[1],
    })
  }
  return findings
}

export function lockedDirectPnpmVersions(lockfile) {
  const versions = new Map()
  let inRootImporter = false
  let inDependencies = false
  let dependency = ''
  for (const line of String(lockfile).split('\n')) {
    if (/^  \.:\s*$/.test(line)) {
      inRootImporter = true
      continue
    }
    if (inRootImporter && /^packages:\s*$/.test(line)) break
    if (!inRootImporter) continue
    if (/^    (?:dependencies|devDependencies|optionalDependencies):\s*$/.test(line)) {
      inDependencies = true
      dependency = ''
      continue
    }
    if (/^    \S/.test(line) && !/^    (?:dependencies|devDependencies|optionalDependencies):/.test(line)) {
      inDependencies = false
      dependency = ''
    }
    if (!inDependencies) continue
    const dependencyLine = line.match(/^      (.+):\s*$/)
    if (dependencyLine) {
      dependency = dependencyLine[1].replace(/^['"]|['"]$/g, '')
      continue
    }
    const versionLine = line.match(/^        version:\s*([^\s]+)\s*$/)
    if (dependency && versionLine) {
      versions.set(dependency, versionLine[1].replace(/^['"]|['"]$/g, '').replace(/\(.+$/, ''))
    }
  }
  return versions
}

export function suggestedReplacementNames(note, original = '') {
  const names = []
  const text = String(note || '')
  const action = '(?:use|switch to|migrate to|moved to|renamed to|replaced by|superseded by)'
  const packageName = '(@?[a-z0-9][a-z0-9._-]*(?:\\/[a-z0-9][a-z0-9._-]*)?)'
  const patterns = [
    new RegExp(`${action}\\s+[\\x60'"]${packageName}[\\x60'"]`, 'gi'),
    new RegExp(`${action}\\s+npm:${packageName}`, 'gi'),
    new RegExp(`${action}\\s+(github\\.com\\/[a-z0-9_.-]+\\/[a-z0-9_.-]+(?:\\/v\\d+)?)`, 'gi'),
    /(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@?[a-z0-9_.-]+(?:%2f|\/)[a-z0-9_.-]+|[a-z0-9_.-]+)/gi,
    /(?:https?:\/\/)?github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)/gi
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      names.push(decodeURIComponent(match[1]).replace(/\.git$/i, ''))
    }
  }
  return [...new Set(names.filter((name) =>
    name.toLowerCase() !== String(original).toLowerCase()
  ))]
}

export function replacementLeadLabel(reason) {
  return /(?:heuristic|untrusted|search lead)/i.test(String(reason))
    ? 'Untrusted lead'
    : 'Verified candidate'
}

export function safeReportText(value, maximumLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/([\\`*_[\]{}()<>#+.!|-])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength)
}

export const REQUIRED_CHECKS = [
  'Automated review / policy',
  'Full acceptance / locked OpenCloud stable',
  'CodeQL / go',
  'CodeQL / javascript-typescript',
]

function checkFreshness(check, index) {
  const detailsUrl = String(check?.detailsUrl || check?.targetUrl || '')
  const runMatch = detailsUrl.match(/\/actions\/runs\/(\d+)(?:\/|$)/)
  const jobMatch = detailsUrl.match(/\/job\/(\d+)(?:\/|$)/)
  const timestamps = [check?.startedAt, check?.completedAt]
    .map((value) => Date.parse(value || '') || 0)
  return {
    runId: runMatch ? Number(runMatch[1]) : null,
    jobId: jobMatch ? Number(jobMatch[1]) : null,
    timestamp: Math.max(...timestamps),
    index,
  }
}

function isNewerCheck(candidate, current) {
  if (candidate.runId !== null && current.runId !== null && candidate.runId !== current.runId) {
    return candidate.runId > current.runId
  }
  if (candidate.runId !== null && candidate.runId === current.runId &&
      candidate.jobId !== null && current.jobId !== null && candidate.jobId !== current.jobId) {
    return candidate.jobId > current.jobId
  }
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp > current.timestamp
  if (candidate.runId !== null && current.runId === null) return true
  if (candidate.runId === null && current.runId !== null) return false
  return candidate.index > current.index
}

export function latestRequiredCheckStates(rollup) {
  const latest = new Map()
  for (const [index, check] of (Array.isArray(rollup) ? rollup : []).entries()) {
    const name = check?.name || check?.context
    if (!REQUIRED_CHECKS.includes(name)) continue
    const freshness = checkFreshness(check, index)
    if (!latest.has(name) || isNewerCheck(freshness, latest.get(name))) {
      latest.set(name, {
        state: String(check.conclusion || check.state || check.status || 'pending').toLowerCase(),
        ...freshness,
      })
    }
  }
  return Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, latest.get(name)?.state || 'missing']))
}

export function requiredCheckSummary(rollup) {
  const states = latestRequiredCheckStates(rollup)
  return REQUIRED_CHECKS.map((name) => `${name}: ${states[name]}`).join('; ')
}

export function isAbandonedRenovatePullRequest(pr) {
  const labels = new Set((Array.isArray(pr?.labels) ? pr.labels : [])
    .map((label) => typeof label === 'string' ? label : label?.name))
  return /^renovate\//.test(String(pr?.headRefName || '')) &&
    labels.has('dependencies') &&
    /\s-\sabandoned$/i.test(String(pr?.title || ''))
}

export function isPendingReleasePullRequest(pr) {
  const labels = new Set((Array.isArray(pr?.labels) ? pr.labels : [])
    .map((label) => typeof label === 'string' ? label : label?.name))
  return !isAbandonedRenovatePullRequest(pr) &&
    ['release:weekly', 'security:high', 'security:critical'].some((label) => labels.has(label))
}
