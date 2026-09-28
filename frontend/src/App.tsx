import { lazy, Suspense, useEffect } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ClansPage } from './pages/ClansPage'
import { BattlesPage } from './pages/BattlesPage'
import { Loading } from './components/ui'
import { LOCALES, t, useLocale, type Locale } from './i18n'

// Графики (uPlot) и плеер карты нужны только этим страницам: отдельные чанки
// не тормозят первую загрузку главной, списка кланов и ленты боёв.
const PlayerPage = lazy(() => import('./pages/PlayerPage').then((module) => ({ default: module.PlayerPage })))
const ClanPage = lazy(() => import('./pages/ClanPage').then((module) => ({ default: module.ClanPage })))
const BattlePage = lazy(() => import('./pages/BattlePage').then((module) => ({ default: module.BattlePage })))

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
        {/* Логотип — единственная дорога на главную с поиском. */}
        <NavLink to="/" className="brand" title={t('nav.brandTitle')}>wt<span>bot</span></NavLink>
        <NavLink to="/clans" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{t('nav.clans')}</NavLink>
        <NavLink to="/battles" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{t('nav.battles')}</NavLink>
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
        <a className="nav-ext" href="/">{t('nav.botPanel')}</a>
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
