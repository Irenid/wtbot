import assert from 'node:assert/strict'
import test from 'node:test'
import { botText } from '../i18n/index.js'
import { heatmapQualityRow, heatmapScaleForUpload } from './battle-media-controls.js'

test('the heatmap quality button toggles 1× and 2× in the same message, in the bot language', () => {
  const hd = heatmapQualityRow('heatmap-team-air-1', '499318960664935978', 1, botText('en')).toJSON().components[0]!
  assert.ok('custom_id' in hd && 'label' in hd)
  assert.equal(hd.custom_id, 'battle:heatmap-team-air-1:499318960664935978:2')
  assert.equal(hd.label, 'Open at 2×')

  const normal = heatmapQualityRow('heatmap-team-air-1', '499318960664935978', 2, botText('en')).toJSON().components[0]!
  assert.ok('custom_id' in normal && 'label' in normal)
  assert.equal(normal.custom_id, 'battle:heatmap-team-air-1:499318960664935978:1')
  assert.equal(normal.label, 'Back to 1×')

  const russian = heatmapQualityRow('heatmap-ground', '1', 1, botText('ru')).toJSON().components[0]!
  assert.ok('label' in russian)
  assert.equal(russian.label, 'Открыть в 2×')
})

test('a 2× map keeps its scale when it fits Discord\'s limit', () => {
  assert.equal(heatmapScaleForUpload(2, 10 * 1024 * 1024, 10 * 1024 * 1024), 2)
})

test('a 2× map falls back to 1× over Discord\'s limit', () => {
  assert.equal(heatmapScaleForUpload(2, 10 * 1024 * 1024 + 1, 10 * 1024 * 1024), 1)
})

test('a 1× map stays at 1× whatever the limit', () => {
  assert.equal(heatmapScaleForUpload(1, 20 * 1024 * 1024, 10 * 1024 * 1024), 1)
})
