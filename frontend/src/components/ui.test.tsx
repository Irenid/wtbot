import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SiteApiError } from '../api'
import { t } from '../i18n'
import { ErrorNotice, SegControl, segControlTarget } from './ui'

const notice = (error: unknown): string => renderToStaticMarkup(<ErrorNotice error={error} />)

describe('SegControl', () => {
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] as const

  it('is a radio group whose chosen option alone takes Tab', () => {
    const markup = renderToStaticMarkup(<SegControl options={options} value="b" onChange={() => {}} ariaLabel="Mode" />)
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('aria-label="Mode"')
    expect(markup.match(/role="radio"/g)).toHaveLength(3)
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(markup.match(/tabindex="0"/gi)).toHaveLength(1)
    expect(markup).toMatch(/aria-checked="true" tabindex="0"[^>]*>B</i)
  })

  it('gives Tab to the first option when none is chosen', () => {
    const markup = renderToStaticMarkup(<SegControl options={options} value={'x' as 'a'} onChange={() => {}} />)
    expect(markup).toMatch(/tabindex="0"[^>]*>A</i)
  })

  it('moves the choice with the arrow keys, wrapping, and jumps with Home and End', () => {
    expect(segControlTarget(0, 3, 'ArrowRight')).toBe(1)
    expect(segControlTarget(2, 3, 'ArrowRight')).toBe(0)
    expect(segControlTarget(2, 3, 'ArrowDown')).toBe(0)
    expect(segControlTarget(0, 3, 'ArrowLeft')).toBe(2)
    expect(segControlTarget(1, 3, 'ArrowUp')).toBe(0)
    expect(segControlTarget(1, 3, 'Home')).toBe(0)
    expect(segControlTarget(0, 3, 'End')).toBe(2)
    expect(segControlTarget(-1, 3, 'ArrowRight')).toBe(0)
    expect(segControlTarget(1, 3, 'Enter')).toBeNull()
    expect(segControlTarget(0, 0, 'ArrowRight')).toBeNull()
  })
})

describe('ErrorNotice', () => {
  it('translates the API codes it knows', () => {
    for (const code of ['PLAYER_NOT_FOUND', 'CLAN_NOT_FOUND', 'BATTLE_NOT_FOUND', 'RATE_LIMITED', 'INVALID_CLAN', 'INVALID_BATTLE', 'INVALID_PERIOD'] as const) {
      const markup = notice(new SiteApiError(400, code, 'server text'))
      expect(markup).toContain(t(`apiError.${code}`))
      expect(markup).not.toContain('server text')
    }
  })

  it('shows the server text for another code and the message of any other error', () => {
    expect(notice(new SiteApiError(500, 'BAD_RESPONSE', 'HTTP 500: the response is not JSON'))).toBe(
      '<div class="notice fail">HTTP 500: the response is not JSON</div>',
    )
    expect(notice(new TypeError('Failed to fetch'))).toContain('Failed to fetch')
    expect(notice('aborted')).toContain('aborted')
  })

  it('escapes the text it shows', () => {
    expect(notice(new Error('<img src=x onerror=alert(1)>'))).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
