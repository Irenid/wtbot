import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GAIJIN_RELOGIN_URL,
  isSignedInSession,
  isSiteLogout,
  pageAccountId,
  reLoginUrlFromHtml,
  sessionToken,
} from './wt-sign-in.js'

/** The GSEA_init block of https://warthunder.com/en/ as an anonymous visitor got it on 2026-10-13. */
const ANONYMOUS_PAGE = `
        w['GSEA_init'] = {
            debug: false,
            loginURI: 'https://login.gaijin.net',
            embedURI: 'https://embed.gaijin.net',
            autoLogin: true,
            uid: '',
            jwt: '',
            queryContext: '${GAIJIN_RELOGIN_URL}',
            onLoad: (client) => {
                client.on('change', (newSession, oldSession) => {
                    if (newSession.uid !== oldSession.uid) {`

test('reLoginUrlFromHtml reads the reLogin address of the site page', () => {
  assert.equal(reLoginUrlFromHtml(ANONYMOUS_PAGE), GAIJIN_RELOGIN_URL)
  assert.equal(reLoginUrlFromHtml('<html><body>no sign-in script</body></html>'), null)
})

test('reLoginUrlFromHtml accepts only a Gaijin SSO page', () => {
  const page = (url: string) => `queryContext: '${url}',`
  assert.equal(reLoginUrlFromHtml(page('https://login.example.com/en/sso/reLogin/?a=1')), null)
  assert.equal(reLoginUrlFromHtml(page('https://login.gaijin.net/en/download/')), null)
  assert.equal(reLoginUrlFromHtml(page('not a url')), null)
  assert.equal(
    reLoginUrlFromHtml(page('https://login.gaijin.net/en/sso/reLogin/?return_url=x&crc=y')),
    'https://login.gaijin.net/en/sso/reLogin/?return_url=x&crc=y',
  )
})

test('pageAccountId tells an anonymous page from a signed-in one', () => {
  assert.equal(pageAccountId(ANONYMOUS_PAGE), '')
  assert.equal(pageAccountId(ANONYMOUS_PAGE.replace("uid: ''", "uid: '123456789'")), '123456789')
  assert.equal(pageAccountId('<html></html>'), null)
})

test('a signed-in set names the account and carries its token', () => {
  const anonymous = [{ name: 'identity_sid', value: 'sid' }]
  const signedIn = [...anonymous, { name: 'identity_id', value: '42' }, { name: 'identity_token', value: 'tok' }]
  assert.equal(isSignedInSession(anonymous), false)
  assert.equal(isSignedInSession(signedIn), true)
  assert.equal(isSignedInSession(signedIn.filter(({ name }) => name !== 'identity_id')), false)
  assert.equal(isSignedInSession([{ name: 'identity_id', value: '42' }, { name: 'identity_token', value: '' }]), false)
  assert.equal(sessionToken(signedIn), 'tok')
  assert.equal(sessionToken(anonymous), null)
})

test('isSiteLogout matches the site sign-out in every language and nothing else', () => {
  const at = (url: string) => isSiteLogout(new URL(url))
  assert.equal(at('https://warthunder.com/en/logout'), true)
  assert.equal(at('https://warthunder.com/ru/logout/?_csrf=x'), true)
  assert.equal(at('https://WARTHUNDER.com/logout'), true)
  assert.equal(at('https://warthunder.com/en/community/searchplayers?name=logout'), false)
  assert.equal(at('https://warthunder.com/en/logout-guide'), false)
  assert.equal(at('https://login.gaijin.net/en/logout'), false)
  assert.equal(at('https://warthunder.com.example.org/en/logout'), false)
})
