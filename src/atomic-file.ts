import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export interface AtomicWriteOptions {
  fileMode?: number | undefined
  directoryMode?: number | undefined
  sync?: boolean | undefined
}

/**
 * Пишет соседний временный файл и атомарно публикует его rename'ом.
 * Короткие повторы нужны Windows, где антивирус может ненадолго держать файл.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: options.directoryMode })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = await open(temporary, 'wx', options.fileMode)
  try {
    await handle.writeFile(data)
    if (options.sync) await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(temporary, file)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}
