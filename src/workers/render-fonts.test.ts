import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRenderFonts } from './render-fonts.js'

test('шрифт игры стоит сразу за UI-шрифтами, раньше письменностей и символьного запаса', () => {
  const gameFont = '/fonts/symbols_skyquake.ttf'
  // Корейский ник подключает шрифт письменности, если он есть в системе.
  const fonts = resolveRenderFonts([gameFont], '<svg><text>╖TAG╖ 후라이</text></svg>')
  // Шрифт с box-drawing раньше шрифта игры перехватит рамки клан-тегов.
  assert.equal(fonts.fontFiles[fonts.uiFileCount], gameFont)
  assert.equal(fonts.customFileCount, 1)
})
