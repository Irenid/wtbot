/**
 * Чистые правила распознавания проверки Cloudflare и склейки cookies.
 * Вынесены из wt-browser.ts, чтобы их можно было проверять без запуска Edge.
 */

const CHALLENGE_TITLE = /just a moment|attention required|verify you are human|checking your browser/i
export const CHALLENGE_URL = /__cf_chl|\/cdn-cgi\/challenge-platform/i

export interface ChallengeCandidate {
  status: number
  url: string
  headers: Record<string, string>
}

export interface PageSignals {
  url: string
  title: string
  bodyLength: number
  challengeMarkup: boolean
}

export interface NamedCookie {
  name: string
  value: string
  domain: string
}

/**
 * Ответ считается проверкой только при 403: заголовок cf-mitigated приходит и
 * на обычных страницах, а challenge-платформа встраивается в любой ответ сайта.
 */
export function isChallengeResponse(candidate: ChallengeCandidate): boolean {
  if (candidate.status !== 403) return false
  const mitigated = candidate.headers['cf-mitigated']?.toLowerCase()
  return mitigated === 'challenge' || CHALLENGE_URL.test(candidate.url)
}

/** Признаки того, что страница уже не является страницей проверки. */
export function looksCleared(signals: PageSignals): boolean {
  if (CHALLENGE_URL.test(signals.url)) return false
  if (signals.challengeMarkup) return false
  if (CHALLENGE_TITLE.test(signals.title)) return false
  return signals.bodyLength > 400
}

/**
 * Один и тот же cookie приходит и с точкой в домене, и без неё. Побеждает
 * host-cookie — так же, как его выбрал бы сам браузер при отправке запроса.
 */
export function preferHostCookies(
  cookies: readonly NamedCookie[],
): Array<{ name: string; value: string }> {
  const byName = new Map<string, { value: string; hostCookie: boolean }>()
  for (const cookie of cookies) {
    const hostCookie = !cookie.domain.startsWith('.')
    const known = byName.get(cookie.name)
    if (known === undefined || (hostCookie && !known.hostCookie)) {
      byName.set(cookie.name, { value: cookie.value, hostCookie })
    }
  }
  return [...byName].map(([name, { value }]) => ({ name, value }))
}
