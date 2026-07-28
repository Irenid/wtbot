import { NavLink, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { PlayerPage } from './pages/PlayerPage'
import { ClansPage } from './pages/ClansPage'
import { ClanPage } from './pages/ClanPage'
import { BattlesPage } from './pages/BattlesPage'
import { BattlePage } from './pages/BattlePage'
import { LOCALES, t, useLocale, type Locale } from './i18n'

export function App() {
  const { locale, setLocale } = useLocale()
  return (
    <div className="layout">
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
      <footer className="site-footer">wtbot</footer>
    </div>
  )
}
