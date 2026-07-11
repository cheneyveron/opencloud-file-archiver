import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAppStoreEntry } from '../../scripts/app-store-entry.mjs'

test('release catalog metadata discloses and versions the required backend', () => {
  const entry = buildAppStoreEntry({ version: '1.2.3', openCloudRelease: 'v7.2.1' })

  assert.match(entry.description, /backend service/i)
  assert.deepEqual(entry.versions, [
    {
      version: '1.2.3',
      minOpenCloud: '7.2.1',
      url: 'https://github.com/cheneyveron/opencloud-file-archiver/releases/download/v1.2.3/file-archiver-1.2.3.zip',
      filename: 'file-archiver-1.2.3.zip',
    },
  ])
  assert.match(entry.resources[0].url, /\/blob\/v1\.2\.3\/INSTALL\.md$/)
})

test('catalog metadata rejects non-formal versions', () => {
  assert.throws(
    () => buildAppStoreEntry({ version: 'latest', openCloudRelease: 'v7.2.1' }),
    /strict X\.Y\.Z/,
  )
})
