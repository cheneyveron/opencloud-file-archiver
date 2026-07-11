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

const requiredChecks = [
  'Automated review / policy',
  'Full acceptance / locked OpenCloud stable',
]

export function requiredCheckSummary(rollup) {
  const latest = new Map()
  for (const check of Array.isArray(rollup) ? rollup : []) {
    const name = check?.name || check?.context
    if (!requiredChecks.includes(name)) continue
    const timestamp = Date.parse(check.startedAt || check.completedAt || '') || 0
    if (!latest.has(name) || timestamp >= latest.get(name).timestamp) {
      latest.set(name, {
        state: String(check.conclusion || check.state || check.status || 'pending').toLowerCase(),
        timestamp,
      })
    }
  }
  return requiredChecks.map((name) => `${name}: ${latest.get(name)?.state || 'missing'}`).join('; ')
}
