import { t } from '../../i18n'

export interface PageSection {
  id: string
  label: string
}

/**
 * The sticky contents of a long page: the buttons scroll to a section instead of
 * changing the address, so the router does not redraw the page. The sections'
 * scroll-margin (.player-section) leaves room for the header.
 */
export function SectionNav({ sections }: { sections: readonly PageSection[] }) {
  if (sections.length < 2) return null
  return (
    <nav className="section-nav" aria-label={t('a11y.sections')}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {section.label}
        </button>
      ))}
    </nav>
  )
}
