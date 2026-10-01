import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProfileCountryScores } from './wt-profile-stats.js'

/** Разметка блока «Vehicles and rewards» со страницы профиля (октябрь 2026). */
function scoreBlock(columns: string): string {
  return `<div class="user-profile__score user-score">
    <ul class="user-score__list-title">
      <li class="user-score__list-item"><p>Vehicles and rewards</p></li>
      <li class="user-score__list-item"><span class="user-score__list-title--usaflag"></span> <p> USA </p></li>
      <li class="user-score__list-item"><span class="user-score__list-title--ussrflag"></span> <p> USSR </p></li>
    </ul>
    ${columns}
  </div>`
}

function column(kind: string, values: string[]): string {
  return `<ul class="user-score__list-col"><li class="user-score__list-item user-score__list-item--${kind}"></li>${
    values.map((value) => `<li class="user-score__list-item">${value}</li>`).join('')
  }</ul>`
}

test('parseProfileCountryScores читает технику, элитную технику и медали по нациям', () => {
  const html = scoreBlock(
    column('plane', ['184', '1,210']) + column('elitplanes', ['57', 'N/A']) + column('orderlevel', ['11', '14']),
  )
  assert.deepEqual(parseProfileCountryScores(html), [
    { country: 'USA', vehicles: 184, eliteVehicles: 57, medals: 11 },
    { country: 'USSR', vehicles: 1_210, eliteVehicles: null, medals: 14 },
  ])
})

test('parseProfileCountryScores: без блока и с незнакомым столбцом — без ошибок', () => {
  assert.deepEqual(parseProfileCountryScores('<div class="user-profile"></div>'), [])
  assert.deepEqual(parseProfileCountryScores(scoreBlock(column('newicon', ['1', '2']))), [
    { country: 'USA', vehicles: null, eliteVehicles: null, medals: null },
    { country: 'USSR', vehicles: null, eliteVehicles: null, medals: null },
  ])
})
