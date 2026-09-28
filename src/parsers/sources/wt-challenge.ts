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
  path?: string
  /** Unix-секунды; -1 или отсутствие — session cookie. */
  expires?: number
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

const expiresOf = (cookie: NamedCookie): number =>
  cookie.expires !== undefined && cookie.expires > 0 ? cookie.expires : -1

/** true, если a свежее b: позже истекает; при равенстве — host-cookie. */
function fresher(a: NamedCookie, b: NamedCookie): boolean {
  const byExpiry = expiresOf(a) - expiresOf(b)
  if (byExpiry !== 0) return byExpiry > 0
  return !a.domain.startsWith('.') && b.domain.startsWith('.')
}

/**
 * Один и тот же cookie бывает и с точкой в домене, и без неё. Сервер выдаёт
 * identity_* на `.warthunder.com` с датой истечения и ротирует identity_sid;
 * session-копия без даты — след прежнего seed из jar. Побеждает самый поздний
 * срок, а при равном сроке — host-cookie.
 */
export function freshestCookies(
  cookies: readonly NamedCookie[],
): Array<{ name: string; value: string }> {
  const byName = new Map<string, NamedCookie>()
  for (const cookie of cookies) {
    const known = byName.get(cookie.name)
    if (known === undefined || fresher(cookie, known)) byName.set(cookie.name, cookie)
  }
  return [...byName].map(([name, cookie]) => ({ name, value: cookie.value }))
}

/**
 * Лишние копии одноимённых cookies: браузер отправляет их все, и сервер может
 * прочитать устаревшую identity_sid. Возвращает всё, кроме самой свежей копии.
 */
export function staleDuplicateCookies<T extends NamedCookie>(cookies: readonly T[]): T[] {
  const freshest = new Map<string, T>()
  for (const cookie of cookies) {
    const known = freshest.get(cookie.name)
    if (known === undefined || fresher(cookie, known)) freshest.set(cookie.name, cookie)
  }
  return cookies.filter((cookie) => freshest.get(cookie.name) !== cookie)
}
