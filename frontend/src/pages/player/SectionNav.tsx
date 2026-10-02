import { t } from '../../i18n'

export interface PageSection {
  id: string
  label: string
}

/**
 * Липкое оглавление длинной страницы: кнопки прокручивают к разделу, а не
 * меняют адрес — роутер не перерисовывает страницу. scroll-margin у разделов
 * (.player-section) оставляет место под шапку.
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
