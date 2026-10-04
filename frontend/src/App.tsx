import { lazy, Suspense, useEffect } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ClansPage } from './pages/ClansPage'
import { BattlesPage } from './pages/BattlesPage'
import { Loading } from './components/ui'
import { LOCALES, t, useLocale, type Locale } from './i18n'

// Charts (uPlot), the map player and the guide texts of all five locales are
// needed only on these pages: separate chunks keep the first load of the home
// page, the squadron list and the battle feed light. Both guide pages share one chunk.
const PlayerPage = lazy(() => import('./pages/PlayerPage').then((module) => ({ default: module.PlayerPage })))
const ClanPage = lazy(() => import('./pages/ClanPage').then((module) => ({ default: module.ClanPage })))
const BattlePage = lazy(() => import('./pages/BattlePage').then((module) => ({ default: module.BattlePage })))
const GuidesPage = lazy(() => import('./pages/GuidesPage').then((module) => ({ default: module.GuidesPage })))
const GuidePage = lazy(() => import('./pages/GuidesPage').then((module) => ({ default: module.GuidePage })))

/** Репозиторий исходного кода: AGPL-3.0 требует предложить его пользователям сети. */
const SOURCE_URL = 'https://github.com/Irenid/wtbot'

/** Новая страница открывается сверху, а не с прокруткой предыдущей. */
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

export function App() {
  const { locale, setLocale } = useLocale()
  return (
    <div className="layout">
      <ScrollToTop />
      <nav className="topnav">
        {/* The logo is the only way back to the home page with search. */}
        <NavLink to="/" className="brand" title={t('nav.brandTitle')}>wt<span>bot</span></NavLink>
        <NavLink to="/clans" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{t('nav.clans')}</NavLink>
        <NavLink to="/battles" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{t('nav.battles')}</NavLink>
        <NavLink to="/guides" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{t('nav.guides')}</NavLink>
        <span className="spacer" />
        <select
          className="select"
          style={{ width: 'auto', padding: '5px 8px', fontSize: 12 }}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
          aria-label={t('nav.language')}
        >
          {LOCALES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
        {/* The bot dashboard, DASHBOARD_PATH in src/web/routes/pages.ts. */}
        <a className="nav-ext" href="/statistics">{t('nav.botPanel')}</a>
      </nav>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/players/id/:identityId" element={<PlayerPage kind="identity" />} />
          <Route path="/players/:wtUserId" element={<PlayerPage kind="wt" />} />
          <Route path="/clans" element={<ClansPage />} />
          <Route path="/clans/:coreTag" element={<ClanPage />} />
          <Route path="/battles" element={<BattlesPage />} />
          <Route path="/battles/:battleKey" element={<BattlePage />} />
          <Route path="/guides" element={<GuidesPage />} />
          <Route path="/guides/:slug" element={<GuidePage />} />
          <Route path="*" element={<div className="notice">{t('common.notFound')}</div>} />
        </Routes>
      </Suspense>
      <footer className="site-footer">
        wtbot · <a href={`${import.meta.env.BASE_URL}LICENSE.txt`}>{t('footer.license')}</a>
        {' · '}<a href={SOURCE_URL} rel="noopener noreferrer">{t('footer.source')}</a>
      </footer>
    </div>
  )
}
