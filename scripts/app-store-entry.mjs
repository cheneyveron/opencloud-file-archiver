import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const strictVersion = /^\d+\.\d+\.\d+$/

export function buildAppStoreEntry({ version, openCloudRelease }) {
  assert.match(version, strictVersion, 'App Store version must be strict X.Y.Z')
  const minimumOpenCloud = String(openCloudRelease || '').replace(/^v/, '')
  assert.match(minimumOpenCloud, strictVersion, 'minimum OpenCloud must be a formal release')

  const releaseBase = `https://github.com/cheneyveron/opencloud-file-archiver/releases/download/v${version}`
  return {
    id: 'com.github.cheneyveron.opencloud-file-archiver',
    name: 'File Archiver',
    subtitle: 'Create, download, browse, preview, and extract archives in OpenCloud.',
    description: '**Requires the matching File Archiver backend service. The Web extension is not functional by itself.**\n\nDeploy `ghcr.io/cheneyveron/opencloud-file-archiver-service:<same-version-as-the-ZIP>` and route `/archive` before use. Do not mix frontend and backend release versions.',
    license: 'AGPL-3.0',
    versions: [
      {
        version,
        minOpenCloud: minimumOpenCloud,
        url: `${releaseBase}/file-archiver-${version}.zip`,
        filename: `file-archiver-${version}.zip`,
      },
    ],
    authors: [{ name: 'Cheney Wang', url: 'https://github.com/cheneyveron' }],
    tags: ['file-management', 'file-action', 'archive'],
    resources: [
      {
        label: 'Installation & backend setup',
        url: `https://github.com/cheneyveron/opencloud-file-archiver/blob/v${version}/INSTALL.md`,
      },
      {
        label: 'GitHub & release notes',
        url: 'https://github.com/cheneyveron/opencloud-file-archiver',
      },
    ],
  }
}

function lockedOpenCloudRelease() {
  const lock = readFileSync('compatibility.lock.yaml', 'utf8')
  const release = lock.match(/^\s*stable_release:\s*"([^"]+)"\s*$/m)?.[1]
  assert.ok(release, 'compatibility.lock.yaml has no stable OpenCloud release')
  return release
}

function verifyEntry(entry, version) {
  const expected = buildAppStoreEntry({ version, openCloudRelease: lockedOpenCloudRelease() })
  assert.deepEqual(entry, expected, 'App Store entry differs from the accepted release metadata')
  assert.match(entry.description, /backend service/i)
  assert.match(entry.resources[0].url, /^https:\/\//)
  assert.match(entry.versions[0].url, /^https:\/\//)
}

async function main() {
  const [operation, version, file] = process.argv.slice(2)
  assert.ok(operation === 'create' || operation === 'verify', 'usage: app-store-entry.mjs <create|verify> X.Y.Z FILE')
  assert.ok(file, 'App Store entry path is required')
  if (operation === 'create') {
    const entry = buildAppStoreEntry({ version, openCloudRelease: lockedOpenCloudRelease() })
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`)
    return
  }
  verifyEntry(JSON.parse(readFileSync(file, 'utf8')), version)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
