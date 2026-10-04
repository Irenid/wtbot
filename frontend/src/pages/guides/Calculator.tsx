import { useState } from 'react'
import { Kpi } from '../../components/ui'
import type { GuideText } from '../../i18n/guide'
import { battlesToReach, breakEvenWinRate, expectedChange, lossPoints, psrCeiling, winPoints } from '../../lib/psr'
import { Change, num, pct, psrText, signed } from './parts'

const MAX_PSR = 3000
/** "Reached" means within this many points of the level, as the "battles from zero" column. */
const NEAR = 50

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** PSR and win rate in, the formula's numbers out; every input change recomputes (at most ~10,000 cheap steps). */
export function Calculator({ g }: { g: GuideText }) {
  const c = g.psr.calc
  const [psrInput, setPsrInput] = useState('1500')
  const [rateInput, setRateInput] = useState('55')
  const psr = clamp(Number(psrInput) || 0, 0, MAX_PSR)
  const winRate = clamp(Number(rateInput) || 0, 0, 100) / 100
  const ceiling = psrCeiling(winRate)

  let ceilingValue: string
  let ceilingSub: string | undefined
  let battlesValue = '—'
  let battlesSub: string | undefined
  if (ceiling === Infinity) {
    ceilingValue = '∞'
    ceilingSub = c.endless
  } else if (ceiling === 0) {
    ceilingValue = '0'
    ceilingSub = c.stuck
  } else {
    ceilingValue = psrText(Math.round(ceiling / 10) * 10)
    if (psr < ceiling - NEAR) {
      const battles = battlesToReach(psr, ceiling - NEAR, winRate)
      if (battles !== null) {
        battlesValue = `~${num(battles)}`
        battlesSub = c.fromNow
      }
    } else if (psr <= ceiling + NEAR) {
      battlesValue = '0'
      battlesSub = c.reached
    } else {
      battlesSub = c.above
    }
  }

  return (
    <>
      <div className="guide-calc">
        <label className="guide-field">
          <span className="l">{c.psr}</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_PSR}
            step={10}
            value={psrInput}
            onChange={(event) => setPsrInput(event.target.value)}
          />
        </label>
        <label className="guide-field">
          <span className="l">{c.winRate}</span>
          <span className="guide-unit">
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={1}
              value={rateInput}
              onChange={(event) => setRateInput(event.target.value)}
            />
            <span aria-hidden="true">%</span>
          </span>
        </label>
      </div>
      <div className="kpis guide-kpis">
        <Kpi label={c.win} value={<span className="guide-win">{signed(winPoints(psr), 1)}</span>} />
        <Kpi label={c.loss} value={<span className="guide-loss">{signed(-lossPoints(psr), 1)}</span>} />
        <Kpi label={c.hold} value={pct(breakEvenWinRate(psr))} />
        <Kpi label={c.per10} value={<Change value={10 * expectedChange(psr, winRate)} />} />
        <Kpi label={c.ceiling} value={ceilingValue} sub={ceilingSub} />
        <Kpi label={c.battles} value={battlesValue} sub={battlesSub} />
      </div>
      <p className="guide-note">{c.note}</p>
    </>
  )
}
