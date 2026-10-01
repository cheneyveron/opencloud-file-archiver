import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const digestPattern = /^sha256:[a-f0-9]{64}$/

function newer(candidate, current) {
  const a = candidate.split('.').map(BigInt)
  const b = current.split('.').map(BigInt)
  const index = a.findIndex((part, index) => part !== b[index])
  return index >= 0 && a[index] > b[index]
}

export function latestStableDockerImage(records) {
  let latest
  for (const record of records) {
    if (!versionPattern.test(record?.name || '') || !digestPattern.test(record?.digest || '')) continue
    if (!latest || newer(record.name, latest.name)) latest = record
  }
  assert.ok(latest, 'No published stable OpenCloud Docker image was found')
  return {
    opencloud_release: `v${latest.name}`,
    opencloud_image: `opencloudeu/opencloud:${latest.name}@${latest.digest}`,
  }
}

export function latestStableWebRelease(records) {
  let latest
  for (const release of records) {
    const version = String(release?.tag_name || '').replace(/^v/, '')
    if (release?.tag_name !== `v${version}` || !versionPattern.test(version) ||
        release.draft || release.prerelease || !release.published_at) continue
    if (!latest || newer(version, latest.tag_name.slice(1))) latest = release
  }
  assert.ok(latest, 'No published stable OpenCloud Web release was found')
  const assets = latest.assets?.filter((asset) => asset.name === 'web.tar.gz') || []
  assert.equal(assets.length, 1, `${latest.tag_name} must publish exactly one web.tar.gz`)
  const asset = assets[0]
  const url = `https://github.com/opencloud-eu/web/releases/download/${latest.tag_name}/web.tar.gz`
  assert.equal(asset.browser_download_url, url, 'OpenCloud Web asset must come from its official release')
  assert.match(asset.digest || '', digestPattern, 'OpenCloud Web asset must have a published SHA256 digest')
  return { web_release: latest.tag_name, web_url: url, web_sha256: asset.digest.slice(7) }
}

export function assertCurrentOpenCloud(expected, current) {
  for (const key of ['opencloud_release', 'opencloud_image', 'web_release', 'web_url', 'web_sha256', 'go', 'node', 'pnpm']) {
    assert.equal(expected?.[key], current[key], `Accepted OpenCloud target changed: ${key}; rerun full acceptance against the latest releases`)
  }
}

export async function resolveOpenCloud({ request = fetch } = {}) {
  async function read(url, raw = false) {
    const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/json' }
    if (new URL(url).hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28'
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const response = await request(url, { headers, signal: AbortSignal.timeout(60_000) })
    assert.ok(response.ok, `OpenCloud discovery failed: ${response.status} for ${url}`)
    return raw ? response.text() : response.json()
  }

  async function dockerTags() {
    const records = []
    let url = 'https://hub.docker.com/v2/repositories/opencloudeu/opencloud/tags?page_size=100&ordering=last_updated'
    for (let page = 0; url && page < 100; page += 1) {
      const response = await read(url)
      assert.ok(Array.isArray(response.results), 'Docker Hub returned invalid OpenCloud tags')
      records.push(...response.results)
      if (!response.next) return records
      const next = new URL(response.next)
      assert.equal(next.origin, 'https://hub.docker.com', 'Docker Hub returned an untrusted pagination origin')
      assert.match(next.pathname, /^\/v2\/repositories\/opencloudeu\/opencloud\/tags\/?$/, 'Docker Hub pagination left the stable repository')
      url = next.href
    }
    throw new Error('OpenCloud Docker tag pagination exceeded its limit')
  }

  async function webReleases() {
    const records = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await read(`https://api.github.com/repos/opencloud-eu/web/releases?per_page=100&page=${page}`)
      assert.ok(Array.isArray(response), 'GitHub returned invalid OpenCloud Web releases')
      records.push(...response)
      if (response.length < 100) return records
    }
    throw new Error('OpenCloud Web release pagination exceeded its limit')
  }

  const [images, releases] = await Promise.all([dockerTags(), webReleases()])
  const backend = latestStableDockerImage(images)
  const web = latestStableWebRelease(releases)
  const [goMod, packageSource] = await Promise.all([
    read(`https://api.github.com/repos/opencloud-eu/opencloud/contents/go.mod?ref=${backend.opencloud_release}`, true),
    read(`https://api.github.com/repos/opencloud-eu/web/contents/package.json?ref=${web.web_release}`, true),
  ])
  const packageJson = JSON.parse(packageSource)
  assert.equal(packageJson.version, web.web_release.slice(1), 'OpenCloud Web package version must match its release')
  const go = goMod.match(/^go\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?)\s*$/m)?.[1]
  const node = packageJson.volta?.node
  const pnpm = String(packageJson.packageManager || '').match(/^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+sha\d+\..+)?$/)?.[1]
  assert.ok(go, 'OpenCloud stable release must declare its Go baseline')
  assert.match(node || '', versionPattern, 'OpenCloud Web must declare a stable Node baseline')
  assert.ok(pnpm, 'OpenCloud Web must declare a stable pnpm baseline')
  return { ...backend, ...web, go, node, pnpm }
}

async function main() {
  const mode = process.argv[2]
  assert.ok(mode === undefined || mode === 'github-output', 'usage: resolve-opencloud.mjs [github-output]')
  const target = await resolveOpenCloud()
  if (process.env.ACCEPTED_OPENCLOUD_TARGET) {
    assertCurrentOpenCloud(JSON.parse(process.env.ACCEPTED_OPENCLOUD_TARGET), target)
  }
  if (mode === 'github-output') {
    assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required')
    appendFileSync(process.env.GITHUB_OUTPUT,
      `opencloud_target=${JSON.stringify(target)}\nopencloud_release=${target.opencloud_release}\nweb_release=${target.web_release}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(target, null, 2)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
