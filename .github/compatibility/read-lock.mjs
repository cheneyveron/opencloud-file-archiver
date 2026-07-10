import { appendFileSync, readFileSync } from 'node:fs'

const lockPath = 'compatibility.lock.yaml'
const source = readFileSync(lockPath, 'utf8')
if (source.includes('\t')) throw new Error(`${lockPath} must not contain tabs`)

const required = new Map([
  ['opencloud.channel', null],
  ['opencloud.stable_release', null],
  ['opencloud.image', null],
  ['toolchains.go', null],
  ['toolchains.go_image', null],
  ['toolchains.node', null],
  ['toolchains.node_image', null],
  ['toolchains.pnpm', null],
  ['toolchains.playwright_image', null],
  ['toolchains.caddy_image', null],
  ['toolchains.trivy_image', null],
  ['toolchains.govulncheck', null],
  ['toolchains.buildx', null],
  ['toolchains.buildkit_image', null],
  ['toolchains.binfmt_image', null],
  ['toolchains.renovate_image', null],
  ['toolchains.go_module_minimum', null]
])

const targetSections = new Set(['opencloud', 'toolchains'])
const sectionCounts = new Map()
let section = ''
for (const [index, line] of source.split('\n').entries()) {
  const targetHeader = line.match(/^(opencloud|toolchains)\s*:/)
  if (targetHeader && line !== `${targetHeader[1]}:`) {
    throw new Error(`${lockPath}:${index + 1}: ${targetHeader[1]} must use a plain block mapping`)
  }
  const sectionMatch = line.match(/^([a-z][a-z0-9_]*):$/)
  if (sectionMatch) {
    section = sectionMatch[1]
    if (targetSections.has(section)) {
      sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1)
    }
    continue
  }
  if (/^[^\s#]/.test(line)) section = ''
  if (!targetSections.has(section) || !line.startsWith('  ') || line.trimStart().startsWith('#')) continue
  const anyScalar = line.match(/^  ([a-z][a-z0-9_]*)\s*:/)
  if (anyScalar && required.has(`${section}.${anyScalar[1]}`) &&
      !/^  ([a-z][a-z0-9_]*):\s+("(?:[^"\\]|\\.)*")$/.test(line)) {
    throw new Error(`${lockPath}:${index + 1}: ${section}.${anyScalar[1]} must be one quoted scalar`)
  }
  const scalarMatch = line.match(/^  ([a-z][a-z0-9_]*):\s+("(?:[^"\\]|\\.)*")$/)
  if (!scalarMatch) continue
  const qualified = `${section}.${scalarMatch[1]}`
  if (!required.has(qualified)) continue
  if (required.get(qualified) !== null) throw new Error(`${lockPath}:${index + 1}: duplicate ${qualified}`)
  const value = JSON.parse(scalarMatch[2])
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${qualified} must be a non-empty single-line string`)
  required.set(qualified, value)
}

for (const sectionName of targetSections) {
  if (sectionCounts.get(sectionName) !== 1) throw new Error(`${lockPath} must contain exactly one ${sectionName} section`)
}
for (const [key, value] of required) {
  if (value === null) throw new Error(`${lockPath} must contain exactly one quoted ${key} value`)
}

const value = (key) => required.get(key)
const semver = /^[0-9]+\.[0-9]+\.[0-9]+$/
const dockerDigest = /^[a-z0-9][a-z0-9./-]*:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[a-f0-9]{64}$/

if (value('opencloud.channel') !== 'stable') throw new Error('opencloud.channel must be stable')
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value('opencloud.stable_release'))) {
  throw new Error('opencloud.stable_release must be strict vX.Y.Z')
}
for (const key of [...required.keys()].filter((item) => item.endsWith('_image') || item === 'opencloud.image')) {
  if (!dockerDigest.test(value(key))) throw new Error(`${key} must be an exact tag@sha256 Docker reference`)
}
for (const key of ['toolchains.go', 'toolchains.node', 'toolchains.pnpm', 'toolchains.go_module_minimum']) {
  if (!semver.test(value(key))) throw new Error(`${key} must be strict X.Y.Z`)
}
for (const key of ['toolchains.govulncheck', 'toolchains.buildx']) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value(key))) throw new Error(`${key} must be strict vX.Y.Z`)
}

const stableVersion = value('opencloud.stable_release').slice(1)
if (!value('opencloud.image').startsWith(`opencloudeu/opencloud:${stableVersion}@sha256:`)) {
  throw new Error('opencloud.image tag must equal opencloud.stable_release')
}
if (!value('toolchains.go_image').startsWith(`golang:${value('toolchains.go')}-`)) {
  throw new Error('toolchains.go_image tag must match toolchains.go')
}
if (!value('toolchains.node_image').startsWith(`node:${value('toolchains.node')}-`)) {
  throw new Error('toolchains.node_image tag must match toolchains.node')
}

const packageJson = JSON.parse(readFileSync('web-app-file-archiver/package.json', 'utf8'))
if (packageJson.packageManager !== `pnpm@${value('toolchains.pnpm')}`) {
  throw new Error('package.json packageManager must match toolchains.pnpm')
}
const goMod = readFileSync('file-archiver-service/go.mod', 'utf8')
if (goMod.match(/^go\s+(\S+)/m)?.[1] !== value('toolchains.go_module_minimum')) {
  throw new Error('go.mod directive must match toolchains.go_module_minimum')
}
const dockerfile = readFileSync('file-archiver-service/Dockerfile', 'utf8')
if (dockerfile.match(/^FROM\s+(\S+)\s+AS\s+build$/m)?.[1] !== value('toolchains.go_image')) {
  throw new Error('Dockerfile build image must match toolchains.go_image')
}
const playwrightVersion = readFileSync('web-app-file-archiver/pnpm-lock.yaml', 'utf8')
  .match(/@playwright\/test@([0-9]+\.[0-9]+\.[0-9]+)/)?.[1]
if (!playwrightVersion || !value('toolchains.playwright_image').includes(`:v${playwrightVersion}-`)) {
  throw new Error('toolchains.playwright_image must match the locked @playwright/test version')
}

const output = {
  opencloud_image: value('opencloud.image'),
  go_version: value('toolchains.go'),
  go_image: value('toolchains.go_image'),
  node_version: value('toolchains.node'),
  node_image: value('toolchains.node_image'),
  pnpm_version: value('toolchains.pnpm'),
  playwright_image: value('toolchains.playwright_image'),
  caddy_image: value('toolchains.caddy_image'),
  trivy_image: value('toolchains.trivy_image'),
  govulncheck_version: value('toolchains.govulncheck'),
  buildx_version: value('toolchains.buildx'),
  buildkit_image: value('toolchains.buildkit_image'),
  binfmt_image: value('toolchains.binfmt_image'),
  renovate_image: value('toolchains.renovate_image'),
  go_module_minimum: value('toolchains.go_module_minimum')
}

if (process.argv[2] === 'github-output') {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, item]) => `${key}=${item}\n`).join(''))
} else {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}
