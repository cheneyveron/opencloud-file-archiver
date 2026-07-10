import { AppConfigObject, useRequestHeaders } from '@opencloud-eu/web-pkg'
import { unref } from 'vue'
import { useGettext } from 'vue3-gettext'

export type ArchiveServiceConfig = AppConfigObject & {
  fileArchiverServiceUrl?: string
  archiveServiceUrl?: string
  unarchiveServiceUrl?: string
}

export class ArchiveServiceError extends Error {
  code?: string
  status?: number

  constructor(message: string, { code, status }: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'ArchiveServiceError'
    this.code = code
    this.status = status
  }
}

const DEFAULT_SERVICE_URL = '/archive'
const HEALTHY_CACHE_TTL_MS = 5 * 60 * 1000
const UNHEALTHY_CACHE_TTL_MS = 15 * 1000

type HealthCacheEntry = {
  expiresAt: number
  result: Promise<boolean>
}

const healthCaches = new WeakMap<typeof globalThis.fetch, Map<string, HealthCacheEntry>>()

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

export function getArchiveServiceUrl(applicationConfig: ArchiveServiceConfig = {}) {
  return trimTrailingSlash(
    applicationConfig.fileArchiverServiceUrl ||
      applicationConfig.archiveServiceUrl ||
      applicationConfig.unarchiveServiceUrl ||
      DEFAULT_SERVICE_URL
  )
}

function getHealthCache(fetchImplementation: typeof globalThis.fetch) {
  let cache = healthCaches.get(fetchImplementation)
  if (!cache) {
    cache = new Map<string, HealthCacheEntry>()
    healthCaches.set(fetchImplementation, cache)
  }
  return cache
}

function isHealthyPayload(payload: unknown) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'status' in payload &&
    (payload as { status?: unknown }).status === 'ok'
  )
}

function probeArchiveService(
  serviceUrl: string,
  fetchImplementation: typeof globalThis.fetch
) {
  const cache = getHealthCache(fetchImplementation)
  const cached = cache.get(serviceUrl)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }

  const entry: HealthCacheEntry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve(false)
  }
  entry.result = (async () => {
    try {
      const response = await fetchImplementation(`${serviceUrl}/healthz`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      })
      const payload = await response.json().catch((): undefined => undefined)
      const healthy = response.ok && isHealthyPayload(payload)
      entry.expiresAt = Date.now() + (healthy ? HEALTHY_CACHE_TTL_MS : UNHEALTHY_CACHE_TTL_MS)
      return healthy
    } catch {
      entry.expiresAt = Date.now() + UNHEALTHY_CACHE_TTL_MS
      return false
    }
  })()
  cache.set(serviceUrl, entry)
  return entry.result
}

function markArchiveServiceUnhealthy(
  serviceUrl: string,
  fetchImplementation: typeof globalThis.fetch
) {
  getHealthCache(fetchImplementation).set(serviceUrl, {
    expiresAt: Date.now() + UNHEALTHY_CACHE_TTL_MS,
    result: Promise.resolve(false)
  })
}

function getErrorDetails(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  const error = 'error' in payload ? (payload as { error?: unknown }).error : undefined
  if (typeof error !== 'string' || !error) {
    return undefined
  }

  const code = 'code' in payload ? (payload as { code?: unknown }).code : undefined
  return {
    message: error,
    code: typeof code === 'string' ? code : undefined
  }
}

export function useArchiveService(applicationConfig: ArchiveServiceConfig = {}) {
  const { $gettext } = useGettext()
  const requestHeaders = useRequestHeaders()
  const serviceUrl = getArchiveServiceUrl(applicationConfig)

  function unavailableError() {
    return new ArchiveServiceError(
      $gettext(
        'The File Archiver backend is not installed, is unreachable, or returned an incompatible response. Contact your administrator or follow the backend installation guide.'
      ),
      { code: 'ARCHIVE_BACKEND_UNAVAILABLE' }
    )
  }

  async function request(path: string, init: RequestInit = {}) {
    const fetchImplementation = globalThis.fetch
    if (!(await probeArchiveService(serviceUrl, fetchImplementation))) {
      throw unavailableError()
    }

    let response: Response
    try {
      response = await fetchImplementation(`${serviceUrl}${path}`, {
        ...init,
        headers: {
          ...unref(requestHeaders.headers),
          Accept: 'application/json',
          ...(init.headers || {})
        }
      })
    } catch {
      markArchiveServiceUnhealthy(serviceUrl, fetchImplementation)
      throw unavailableError()
    }

    if (response.ok) {
      return response
    }

    const payload = await response.json().catch((): undefined => undefined)
    const details = getErrorDetails(payload)
    if (details) {
      throw new ArchiveServiceError(details.message, {
        code: details.code,
        status: response.status
      })
    }

    markArchiveServiceUnhealthy(serviceUrl, fetchImplementation)
    throw unavailableError()
  }

  async function requestJson<T>(path: string, init: RequestInit = {}) {
    const response = await request(path, init)
    if (response.status === 204) {
      return undefined as T
    }
    const payload = await response.json().catch((): undefined => undefined)
    if (payload === undefined) {
      markArchiveServiceUnhealthy(serviceUrl, globalThis.fetch)
      throw unavailableError()
    }
    return payload as T
  }

  return {
    serviceUrl,
    request,
    requestJson
  }
}
