import { APIRequestContext, Page, expect, request, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const baseURL = process.env.E2E_BASE_URL as string
const directBaseURL = process.env.E2E_DIRECT_BASE_URL || baseURL
const username = process.env.E2E_USERNAME || 'admin'
const password = process.env.E2E_PASSWORD || 'archiver-acceptance-password'

const sourceFolder = 'e2e-source'
const nestedFolder = 'nested'
const targetFolder = 'e2e-output'
const sourceFile = 'hello.txt'
const archiveName = `${sourceFolder}.zip`
const expectedContents = 'OpenCloud File Archiver acceptance payload\n'

let api: APIRequestContext

test.beforeEach(async () => {
  api = await request.newContext({
    baseURL: directBaseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    }
  })

  await removeResource(sourceFolder)
  await removeResource(targetFolder)
  await removeResource(archiveName)
  for (let index = 1; index <= 3; index += 1) {
    await removeResource(`${sourceFolder} (${index}).zip`)
  }

  await makeCollection(sourceFolder)
  await makeCollection(sourceFolder, nestedFolder)
  await makeCollection(targetFolder)

  const upload = await api.put(davPath(sourceFolder, nestedFolder, sourceFile), {
    data: expectedContents,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
  const uploadBody = await upload.text()
  expect([201, 204], `seed WebDAV upload failed: ${uploadBody}`).toContain(upload.status())
})

test.afterEach(async () => {
  await api?.dispose()
})

test('creates, browses, previews and extracts a ZIP through the installed release', async ({
  page
}) => {
  const frontendFailures: string[] = []
  page.on('pageerror', (error) => frontendFailures.push(`page error: ${error.message}`))
  page.on('response', (response) => {
    const url = response.url()
    if (
      response.status() >= 400 &&
      (url.includes('/archive/') || url.includes('/web/apps/file-archiver/'))
    ) {
      frontendFailures.push(`${response.status()} ${response.request().method()} ${url}`)
    }
  })

  await login(page)
  await expect(resource(page, sourceFolder)).toBeVisible()
  await expect(resource(page, targetFolder)).toBeVisible()

  const directDownload = page.waitForEvent('download', { timeout: 60_000 })
  const directCompression = page.waitForResponse(
    (response) =>
      response.url().includes('/archive/api/compressions') &&
      response.request().method() === 'POST',
    { timeout: 60_000 }
  )
  await openContextAction(page, sourceFolder, '.oc-files-actions-download-zip-archive')
  const directCompressionResponse = await directCompression
  const directCompressionBody = await directCompressionResponse.text()
  expect(directCompressionResponse.status(), directCompressionBody).toBe(202)
  const directCompressionHeaders = await directCompressionResponse.request().allHeaders()
  const directCompressionAuthorization = directCompressionHeaders.authorization
  if (!directCompressionAuthorization) {
    throw new Error('direct-download compression request did not include Authorization')
  }
  const directCompressionJob = JSON.parse(directCompressionBody) as { id?: string }
  if (!directCompressionJob.id) {
    throw new Error('direct-download compression request did not return a job id')
  }
  const downloadedArchive = await directDownload
  expect(downloadedArchive.suggestedFilename()).toBe(archiveName)
  expect(await downloadedArchive.failure()).toBeNull()
  await waitForJob(directCompressionJob.id, directCompressionAuthorization)
  const downloadedArchivePath = await downloadedArchive.path()
  if (!downloadedArchivePath) {
    throw new Error('Playwright did not provide the downloaded ZIP path')
  }
  expect(readZipEntry(await readFile(downloadedArchivePath), `${sourceFolder}/${nestedFolder}/${sourceFile}`)).toBe(
    expectedContents
  )

  await openContextAction(page, sourceFolder, '.oc-files-actions-create-zip-archive')
  const compression = await submitLocationPicker(page, '/archive/api/compressions', {
    allowArchiveNameFallback: true
  })
  await waitForJob(compression.id, compression.authorization)

  await page.reload()
  await expect(resource(page, archiveName)).toBeVisible()

  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/archive/api/previews') &&
      response.request().method() === 'POST'
  )
  await resource(page, archiveName).click()
  expect((await previewResponse).status()).toBe(201)

  const archiveList = page.locator('.archive-viewer__list')
  await expect(page.locator('.archive-viewer')).toBeVisible()
  await archiveList.getByRole('button', { name: sourceFolder, exact: true }).click()
  await archiveList.getByRole('button', { name: nestedFolder, exact: true }).click()
  await archiveList.getByRole('button', { name: sourceFile, exact: true }).click()
  await expect(page.locator('.archive-viewer pre')).toHaveText(expectedContents.trimEnd())

  await page.goBack()
  await expect(resource(page, archiveName)).toBeVisible()

  await openContextAction(page, archiveName, '.oc-files-actions-unzip-archive')
  const extraction = await submitLocationPicker(page, '/archive/api/extractions', {
    target: targetFolder
  })
  await waitForJob(extraction.id, extraction.authorization)

  const extracted = await api.get(davPath(targetFolder, sourceFolder, nestedFolder, sourceFile))
  const extractedContents = await extracted.text()
  expect(extracted.status(), `extracted WebDAV read failed: ${extractedContents}`).toBe(200)
  expect(extractedContents).toBe(expectedContents)

  await page.reload()
  await resource(page, targetFolder).click()
  await expect(resource(page, sourceFolder)).toBeVisible()
  await resource(page, sourceFolder).click()
  await expect(resource(page, nestedFolder)).toBeVisible()
  await resource(page, nestedFolder).click()
  await expect(resource(page, sourceFile)).toBeVisible()

  expect(frontendFailures, 'plugin network requests and browser execution must stay error-free').toEqual(
    []
  )
})

async function makeCollection(...segments: string[]) {
  const response = await api.fetch(davPath(...segments), { method: 'MKCOL' })
  expect([201, 405], `WebDAV MKCOL failed: ${await response.text()}`).toContain(response.status())
}

async function removeResource(...segments: string[]) {
  const response = await api.delete(davPath(...segments))
  expect([204, 404], `WebDAV cleanup failed: ${await response.text()}`).toContain(response.status())
}

function davPath(...segments: string[]) {
  const suffix = segments.map(encodeURIComponent).join('/')
  return `/remote.php/dav/files/${encodeURIComponent(username)}/${suffix}`
}

function resource(page: Page, name: string) {
  return page.locator(
    `#files-space-table [data-test-resource-name="${name}"], #tiles-view [data-test-resource-name="${name}"]`
  )
}

async function login(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Username').fill(username)
  await page.getByPlaceholder('Password').fill(password)
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/logon') &&
        response.request().method() === 'POST' &&
        response.status() === 200
    ),
    page.getByRole('button', { name: 'Log in' }).click()
  ])
}

async function openContextAction(page: Page, resourceName: string, actionSelector: string) {
  await resource(page, resourceName).click({ button: 'right' })
  const action = page.locator(`.context-menu ${actionSelector}`).last()
  await expect(action).toBeVisible()
  await action.click()
}

async function submitLocationPicker(
  page: Page,
  endpoint: string,
  {
    target,
    allowArchiveNameFallback = false
  }: { target?: string; allowArchiveNameFallback?: boolean } = {}
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(endpoint) && response.request().method() === 'POST',
    { timeout: 60_000 }
  )
  const picker = page.frameLocator('.file-archiver-location-picker-modal iframe')
  const selectButton = picker.getByTestId('button-select')
  await expect(selectButton).toBeVisible()

  if (target) {
    await picker.locator(`[data-test-resource-name="${target}"]`).click()
    await expect(selectButton).toBeEnabled()
  }
  await selectButton.click()

  if (allowArchiveNameFallback) {
    const fallbackDialog = page.getByRole('dialog', { name: 'Create archive' })
    const fallbackVisible = await fallbackDialog
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
    if (fallbackVisible) {
      await expect(fallbackDialog.getByLabel('Archive name')).toHaveValue(archiveName)
      await fallbackDialog.getByRole('button', { name: 'Continue' }).click()
    }
  }

  const response = await responsePromise
  const responseBody = await response.text()
  expect(response.status(), responseBody).toBe(202)
  const headers = await response.request().allHeaders()
  const authorization = headers.authorization
  if (!authorization) {
    throw new Error(`browser request to ${endpoint} did not include Authorization`)
  }
  const job = JSON.parse(responseBody) as { id?: string }
  if (!job.id) {
    throw new Error(`${endpoint} did not return a job id`)
  }
  return { id: job.id, authorization }
}

async function waitForJob(id: string, authorization: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await api.get(`/archive/api/jobs/${encodeURIComponent(id)}`, {
      headers: { Authorization: authorization }
    })
    if (!response.ok()) {
      throw new Error(`job ${id} polling failed with HTTP ${response.status()}: ${await response.text()}`)
    }
    const job = (await response.json()) as {
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
      code?: string
      error?: string
    }
    if (job.status === 'succeeded') {
      return
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`job ${id} ${job.status}: ${job.code || ''} ${job.error || ''}`.trim())
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`job ${id} did not finish within 30 seconds`)
}

function readZipEntry(archive: Buffer, expectedName: string) {
  const endOfCentralDirectory = findEndOfCentralDirectory(archive)
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10)
  let offset = archive.readUInt32LE(endOfCentralDirectory + 16)

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid ZIP central-directory entry at offset ${offset}`)
    }
    const compressionMethod = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const fileNameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localHeaderOffset = archive.readUInt32LE(offset + 42)
    const fileName = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8')

    if (fileName === expectedName) {
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`invalid ZIP local header for ${expectedName}`)
      }
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26)
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28)
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize)
      if (compressionMethod === 0) {
        return compressed.toString('utf8')
      }
      if (compressionMethod === 8) {
        return inflateRawSync(compressed).toString('utf8')
      }
      throw new Error(`unsupported ZIP compression method ${compressionMethod} for ${expectedName}`)
    }

    offset += 46 + fileNameLength + extraLength + commentLength
  }

  throw new Error(`downloaded ZIP does not contain ${expectedName}`)
}

function findEndOfCentralDirectory(archive: Buffer) {
  const minimumOffset = Math.max(0, archive.length - 65_557)
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset
    }
  }
  throw new Error('downloaded file has no ZIP end-of-central-directory record')
}
