import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCurrentOpenCloud,
  latestStableDockerImage,
  latestStableWebRelease,
  resolveOpenCloud,
} from '../compatibility/resolve-opencloud.mjs'

const digest = 'sha256:' + 'a'.repeat(64)
const webRelease = (version, overrides = {}) => ({
  tag_name: 'v' + version,
  published_at: '2026-10-01T00:00:00Z',
  draft: false,
  prerelease: false,
  assets: [{
    name: 'web.tar.gz',
    browser_download_url: 'https://github.com/opencloud-eu/web/releases/download/v' + version + '/web.tar.gz',
    digest,
  }],
  ...overrides,
})

test('backend discovery selects the newest published stable Docker tag', () => {
  assert.equal(latestStableDockerImage([
    { name: '7.2.4', digest },
    { name: '8.0.0-rc.1', digest },
    { name: '8.0.0', digest: '' },
    { name: 'latest', digest },
    { name: '08.0.0', digest },
    { name: '7.10.0', digest },
  ]).opencloud_release, 'v7.10.0')
  assert.throws(() => latestStableDockerImage([]), /No published stable/)
})

test('Web follows its own latest stable release without a backend major allowance', () => {
  assert.equal(latestStableWebRelease([
    webRelease('7.99.1'),
    webRelease('9.0.0-rc.1', { prerelease: true }),
    webRelease('9.0.0', { draft: true }),
    webRelease('8.0.0'),
  ]).web_release, 'v8.0.0')
})

test('an incomplete or redirected latest Web release cannot fall back to an old one', () => {
  assert.throws(() => latestStableWebRelease([
    webRelease('7.2.0'),
    webRelease('8.0.0', { assets: [] }),
  ]), /exactly one web.tar.gz/)
  const release = webRelease('8.0.0')
  release.assets[0].browser_download_url = 'https://example.test/web.tar.gz'
  assert.throws(() => latestStableWebRelease([release]), /official release/)
  release.assets[0].browser_download_url = webRelease('8.0.0').assets[0].browser_download_url
  release.assets[0].digest = ''
  assert.throws(() => latestStableWebRelease([release]), /published SHA256/)
})

test('each run discovers backend and Web afresh and reads their exact tagged toolchain metadata', async () => {
  let backend = '7.2.4'
  let web = '8.0.0'
  const requests = []
  const request = async (url) => {
    requests.push(url)
    if (url.startsWith('https://hub.docker.com/')) return Response.json({ results: [{ name: backend, digest }] })
    if (url.includes('/web/releases?')) return Response.json([webRelease(web)])
    if (url.includes('/opencloud/contents/go.mod?ref=v' + backend)) return new Response('module upstream\n\ngo 1.25.0\n')
    if (url.includes('/web/contents/package.json?ref=v' + web)) return Response.json({
      version: web, volta: { node: '26.0.0' }, packageManager: 'pnpm@13.0.0',
    })
    throw new Error('Unexpected upstream lookup: ' + url)
  }
  const first = await resolveOpenCloud({ request })
  backend = '8.1.0'
  web = '9.0.0'
  const second = await resolveOpenCloud({ request })
  assert.equal(first.opencloud_release, 'v7.2.4')
  assert.equal(first.web_release, 'v8.0.0')
  assert.equal(second.opencloud_release, 'v8.1.0')
  assert.equal(second.web_release, 'v9.0.0')
  assert.equal(second.node, '26.0.0')
  assert.equal(second.pnpm, '13.0.0')
  assert.ok(requests.every((url) => !url.includes('rolling')))
  assert.doesNotThrow(() => assertCurrentOpenCloud(first, first))
  assert.throws(() => assertCurrentOpenCloud(first, second), /rerun full acceptance/)
})

test('Docker discovery rejects pagination outside the official stable repository', async () => {
  const request = async (url) => url.startsWith('https://hub.docker.com/')
    ? Response.json({ results: [], next: 'https://example.test/steal' })
    : Response.json([])
  await assert.rejects(resolveOpenCloud({ request }), /untrusted pagination origin/)
})
