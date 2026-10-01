import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureGameFlags } from './game-flags.js'

test('без ui/atlases.vromfs.bin флаги пусты, а картинка боя не падает', async () => {
  const gameDir = await mkdtemp(path.join(tmpdir(), 'wtbot-game-'))
  const previous = process.env['WT_GAME_DIR']
  try {
    // fonts.vromfs.bin есть — каталог принят за клиент игры, атласа с флагами нет.
    await mkdir(path.join(gameDir, 'ui'))
    await writeFile(path.join(gameDir, 'ui', 'fonts.vromfs.bin'), '')
    process.env['WT_GAME_DIR'] = gameDir
    assert.deepEqual(await ensureGameFlags(), new Map())
  } finally {
    if (previous === undefined) delete process.env['WT_GAME_DIR']
    else process.env['WT_GAME_DIR'] = previous
    await rm(gameDir, { recursive: true, force: true })
  }
})
