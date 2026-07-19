import assert from 'node:assert/strict'
import test from 'node:test'
import { heatmapQualityRow, heatmapScaleForUpload } from './battle-media-controls.js'

test('кнопка качества heatmap переключает 1× и 2× в том же сообщении', () => {
  const hd = heatmapQualityRow('heatmap-team-air-1', '499318960664935978', 1).toJSON().components[0]!
  assert.ok('custom_id' in hd && 'label' in hd)
  assert.equal(hd.custom_id, 'battle:heatmap-team-air-1:499318960664935978:2')
  assert.equal(hd.label, 'Открыть в 2×')

  const normal = heatmapQualityRow('heatmap-team-air-1', '499318960664935978', 2).toJSON().components[0]!
  assert.ok('custom_id' in normal && 'label' in normal)
  assert.equal(normal.custom_id, 'battle:heatmap-team-air-1:499318960664935978:1')
  assert.equal(normal.label, 'Вернуть 1×')
})

test('HD-карта сохраняет масштаб 2×, когда помещается в лимит Discord', () => {
  assert.equal(heatmapScaleForUpload(2, 10 * 1024 * 1024, 10 * 1024 * 1024), 2)
})

test('HD-карта переключается на 1× при превышении лимита Discord', () => {
  assert.equal(heatmapScaleForUpload(2, 10 * 1024 * 1024 + 1, 10 * 1024 * 1024), 1)
})

test('обычная карта остаётся в масштабе 1× независимо от лимита', () => {
  assert.equal(heatmapScaleForUpload(1, 20 * 1024 * 1024, 10 * 1024 * 1024), 1)
})
