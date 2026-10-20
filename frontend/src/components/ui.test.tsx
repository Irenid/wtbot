import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SiteApiError } from '../api'
import { t } from '../i18n'
import { ErrorNotice } from './ui'

const notice = (error: unknown): string => renderToStaticMarkup(<ErrorNotice error={error} />)

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
