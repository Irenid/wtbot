import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
const root = path.resolve(path.dirname(entry), '..')

test('старт с отсутствующей БД завершается кодом 1, не создаёт БД и снимает process lock', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wtbot-startup-'))
  const dbPath = path.join(dir, 'missing.db')
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry], {
        cwd: root,
        env: {
          ...process.env,
          // Боевой .env не подхватывается: dotenv читает несуществующий файл.
          DOTENV_CONFIG_PATH: path.join(dir, 'no.env'),
          TOKEN: 'startup-test-token',
          DB_PATH: dbPath,
          WTBOT_ALLOW_NEW_DB: 'false',
          WT_BROWSER_ENABLED: 'false',
          WT_BATTLES_CHANNEL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`процесс не завершился за 60 с:\n${output}`))
      }, 60_000)
      child.on('error', reject)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, output })
      })
    })
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /Файл SQLite не найден/)
    assert.equal(existsSync(dbPath), false, 'без WTBOT_ALLOW_NEW_DB новая БД не создаётся')
    assert.equal(existsSync(`${dbPath}.process.lock`), false, 'аварийный shutdown снимает process lock')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
