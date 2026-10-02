import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { PlayerAccount, PlayerClan, PlayerProfile } from '../../api'
import { Chip, DeltaPill } from '../../components/ui'
import { clanRoleLabel, fmtAge, fmtDate, fmtDateTime, fmtInt } from '../../lib/format'
import { t } from '../../i18n'

export type RefreshState = 'idle' | 'sending' | 'queued' | 'done' | 'unchanged' | 'failed'

const WT_PROFILE_URL = 'https://warthunder.com/en/community/userinfo/?nick='
const STATSHARK_PROFILE_URL = 'https://statshark.net/player/'

/** Буфер обмена есть только в защищённом контексте (HTTPS или localhost). */
const clipboardAvailable = typeof navigator !== 'undefined' && navigator.clipboard !== undefined

export function PlayerHero({ profile, clan, account, updatedAt, refresh, onRefresh }: {
  profile: PlayerProfile
  clan: PlayerClan | null
  /** Сведения об аккаунте: уровень и даты — из любого источника, где они есть. */
  account: Pick<PlayerAccount, 'level' | 'title' | 'registeredAt' | 'lastOnlineAt'>
  updatedAt: number | null
  refresh: RefreshState
  onRefresh: () => void
}) {
  const { player, rating } = profile
  const [copied, setCopied] = useState(false)
  const copyId = () => {
    if (!player.wtUserId) return
    void navigator.clipboard.writeText(player.wtUserId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    }, () => undefined)
  }
  const refreshText = refresh === 'sending' ? t('player.refresh.sending')
    : refresh === 'queued' ? t('player.refresh.queued')
      : refresh === 'done' ? t('player.refresh.done')
        : refresh === 'unchanged' ? t('player.refresh.unchanged')
          : refresh === 'failed' ? t('player.refresh.failed')
            : null

  return (
    <header className="hero-card blue">
      <span className="avatar-tile">{player.nick.slice(0, 1).toUpperCase()}</span>
      <div className="who">
        <h1>
          {player.nick}
          {account.title && <>{' '}<span className="sub">{account.title}</span></>}
        </h1>
        <div className="chips">
          {clan && (clan.coreTag
            ? <Link to={`/clans/${clan.coreTag}`} className="chip accent">{clan.displayTag}</Link>
            : <Chip tone="accent">{clan.displayTag}</Chip>)}
          {clan?.role && <Chip>{clanRoleLabel(clan.role)}</Chip>}
          {account.level !== null && <Chip>{t('player.level', { n: account.level })}</Chip>}
          {player.platform && <Chip>{player.platform}</Chip>}
          {player.wtUserId && (
            <span className="chip">
              {t('player.id', { id: player.wtUserId })}
              {clipboardAvailable && (
                <button type="button" className="chip-action" onClick={copyId} title={t('player.copyId')} aria-label={t('player.copyId')}>
                  {copied ? '✓' : '⧉'}
                </button>
              )}
            </span>
          )}
        </div>
        <div className="hero-meta small muted">
          {account.registeredAt !== null && (
            <span>{t('player.registered', { date: fmtDate(account.registeredAt), age: fmtAge(account.registeredAt) })}</span>
          )}
          {account.lastOnlineAt !== null && <span>{t('player.lastOnline', { date: fmtDate(account.lastOnlineAt) })}</span>}
          {updatedAt !== null && <span>{t('player.updatedChip', { when: fmtDateTime(updatedAt) })}</span>}
        </div>
        <div className="hero-actions">
          <a className="btn small" href={`${WT_PROFILE_URL}${encodeURIComponent(player.nick)}`} target="_blank" rel="noopener noreferrer">
            {t('player.link.wt')} ↗
          </a>
          {player.wtUserId && (
            <a className="btn small" href={`${STATSHARK_PROFILE_URL}${player.wtUserId}`} target="_blank" rel="noopener noreferrer">
              {t('player.link.statshark')} ↗
            </a>
          )}
          <button type="button" className="btn small" onClick={onRefresh} disabled={refresh === 'sending' || refresh === 'queued'}>
            {t('player.refresh')}
          </button>
          {refreshText && (
            <span className={`small ${refresh === 'failed' ? 'fail' : 'muted'}`} role="status">{refreshText}</span>
          )}
        </div>
      </div>
      {rating && (
        <div className="aside">
          <div className="big">
            {fmtInt(rating.rating)}
            {rating.delta !== null && rating.delta !== 0 && (
              <span style={{ marginLeft: 8, verticalAlign: 'middle' }}><DeltaPill value={rating.delta} /></span>
            )}
          </div>
          <div className="label">{t('metric.pkr.personal')}</div>
        </div>
      )}
    </header>
  )
}
