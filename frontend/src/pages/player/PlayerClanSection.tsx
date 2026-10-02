import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { PlayerAccount, PlayerClan, PlayerInsights, PlayerProfile } from '../../api'
import { DeltaPill, SecHead } from '../../components/ui'
import { cleanClanTag, clanRoleLabel, coreClanTag, fmtAge, fmtDate, fmtInt, fmtPercent, fmtPlace } from '../../lib/format'
import { t, tp } from '../../i18n'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="row"><span className="muted">{label}</span><span>{children}</span></div>
}

/** Текущий клан, история кланов по StatShark и кланы из реплеев бота. */
export function PlayerClanSection({ clan, rating, squadrons, playedFor }: {
  clan: PlayerClan | null
  rating: PlayerProfile['rating']
  squadrons: PlayerAccount['squadrons']
  playedFor: PlayerInsights['playedFor'] | null
}) {
  return (
    <div className="grid-2">
      <div className="card" style={{ marginBottom: 0 }}>
        <SecHead title={t('player.clan')} />
        {clan === null ? (
          <div className="muted small">{t('player.clan.none')}</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              {clan.coreTag
                ? <Link to={`/clans/${clan.coreTag}`} style={{ fontSize: 20, fontWeight: 700 }}>{clan.displayTag}</Link>
                : <b style={{ fontSize: 20 }}>{clan.displayTag}</b>}
              {clan.name && <span className="muted">{clan.name}</span>}
              {!clan.coreTag && <span className="muted small">· {t('player.clan.notOnSite')}</span>}
            </div>
            {clan.rank !== null && <Row label={t('player.clan.rank')}>{fmtPlace(clan.rank)}</Row>}
            {clan.totalRating !== null && <Row label={t('player.clan.rating')}>{fmtInt(clan.totalRating)}</Row>}
            {clan.members !== null && <Row label={t('player.clan.members')}>{fmtInt(clan.members)}</Row>}
            {clan.role && <Row label={t('player.clan.role')}>{clanRoleLabel(clan.role)}</Row>}
            {clan.joinedAt !== null && (
              <Row label={t('player.clan.joined')}>{fmtDate(clan.joinedAt)} · {fmtAge(clan.joinedAt)}</Row>
            )}
            {clan.activity !== null && <Row label={t('player.clan.activity')}>{fmtInt(clan.activity)}</Row>}
            {rating && (
              <Row label={t('player.clan.pkr')}>
                {fmtInt(rating.rating)}
                {rating.delta !== null && rating.delta !== 0 && <span style={{ marginLeft: 6 }}><DeltaPill value={rating.delta} /></span>}
              </Row>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <SecHead title={t('player.clan.history')} hint={t('player.clan.history.hint')} />
        {squadrons.length === 0 ? (
          <div className="muted small">{t('player.clan.history.empty')}</div>
        ) : (
          <ol className="timeline">
            {squadrons.map((squadron, index) => (
              <li key={`${squadron.tag}:${squadron.seenAt}`} className={index === 0 ? 'current' : undefined}>
                {squadron.coreTag
                  ? <Link to={`/clans/${squadron.coreTag}`}>{cleanClanTag(squadron.tag)}</Link>
                  : <b>{cleanClanTag(squadron.tag)}</b>}
                <span className="muted small"> · {t('player.clan.history.since', { date: fmtDate(squadron.seenAt) })}</span>
              </li>
            ))}
          </ol>
        )}
        {playedFor !== null && playedFor.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>{t('player.clan.playedFor')}</div>
            {playedFor.map((entry) => {
              const decided = entry.wins + entry.losses
              return (
                <div className="row" key={entry.clanTag}>
                  <span><Link to={`/clans/${coreClanTag(entry.clanTag)}`}>{cleanClanTag(entry.clanTag)}</Link></span>
                  <span>{tp('common.battles', entry.battles)} · {fmtPercent(decided > 0 ? entry.wins / decided : null)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
