import { setImmediate as yieldImmediate } from 'node:timers/promises'

/** Reads a fetch Response as a stream and cuts it off before it allocates too much RAM. */
export async function readResponseBuffer(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const declaredHeader = response.headers.get('content-length')
  const declared = Number(declaredHeader)
  if (declaredHeader !== null && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label}: Content-Length ${declared} is over the ${maxBytes}-byte limit`)
  }
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (
    declaredHeader !== null
    && Number.isSafeInteger(declared)
    && declared >= 0
    && (!contentEncoding || contentEncoding === 'identity')
  ) {
    return readKnownLengthBody(response, declared, label)
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label}: the response is over the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = Buffer.allocUnsafe(total)
  let offset = 0
  let copiedSinceYield = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
    copiedSinceYield += chunk.byteLength
    // Assembling up to 96 MB is CPU and memcpy work too: yield to Discord and
    // Fastify regularly instead of one long synchronous loop.
    if (copiedSinceYield >= 4 * 1024 * 1024 && offset < total) {
      copiedSinceYield = 0
      await yieldImmediate()
    }
  }
  return result
}

async function readKnownLengthBody(
  response: Response,
  declaredBytes: number,
  label: string,
): Promise<Buffer> {
  if (!response.body) {
    if (declaredBytes === 0) return Buffer.alloc(0)
    throw new Error(`${label}: an empty body with Content-Length ${declaredBytes}`)
  }
  const reader = response.body.getReader()
  const result = Buffer.allocUnsafe(declaredBytes)
  let offset = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > declaredBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label}: the body is longer than Content-Length ${declaredBytes}`)
      }
      result.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== declaredBytes) {
    throw new Error(`${label}: a ${offset}-byte body does not match Content-Length ${declaredBytes}`)
  }
  return result
}

export async function readResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  return (await readResponseBuffer(response, maxBytes, label)).toString('utf8')
}

export async function readResponseJson<T>(response: Response, maxBytes: number, label: string): Promise<T> {
  return JSON.parse(await readResponseText(response, maxBytes, label)) as T
}
