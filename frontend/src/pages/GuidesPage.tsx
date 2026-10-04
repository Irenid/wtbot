import { useEffect } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { SecHead } from '../components/ui'
import { useLocale } from '../i18n'
import { guideText } from '../i18n/guide'
import { GUIDES, QUICK, quickNums } from './guides/articles'
import { BATTLES } from './guides/measurements'
import { Rich, num } from './guides/parts'
import { SectionNav } from './player/SectionNav'

/** /guides: quick answers first, then every guide in reading order with its audience. */
export function GuidesPage() {
  const { locale } = useLocale()
  const g = guideText(locale)
  const answers = quickNums(g)
  return (
    <>
      <div className="page-head"><h1>{g.ui.title}</h1></div>
      <p className="guide-lead">{g.ui.lead({ battles: num(BATTLES.total) })}</p>

      <section className="card">
        <SecHead title={g.ui.quickTitle} />
        <dl className="guide-quick">
          {QUICK.map((item) => (
            <div key={item.id}>
              <dt><Link to={item.to}>{g.quick[item.id].q}</Link></dt>
              <dd><Rich text={g.quick[item.id].a(answers)} /></dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card">
        <SecHead title={g.ui.articlesTitle} />
        <div className="guide-cards">
          {GUIDES.map((guide) => (
            <Link key={guide.slug} to={`/guides/${guide.slug}`} className="guide-card">
              <span className="guide-card-title">{g.articles[guide.slug].title}</span>
              <span className="guide-card-summary">{g.articles[guide.slug].summary}</span>
              <span className={`chip${guide.audience === 'commanders' ? ' accent' : ''}`}>{g.ui.audience[guide.audience]}</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  )
}

/** /guides/:slug — one guide; #section in the address scrolls to that section. */
export function GuidePage() {
  const { slug } = useParams()
  const { hash } = useLocation()
  const { locale } = useLocale()
  const g = guideText(locale)
  const index = GUIDES.findIndex((guide) => guide.slug === slug)
  const guide = GUIDES[index]

  // Runs after App's ScrollToTop (an earlier sibling), so a link to a section wins over "open at the top".
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' })
  }, [slug, hash])

  const crumbs = (here: string) => (
    <div className="crumbs">
      <Link to="/guides">{g.ui.title}</Link>
      <span className="sep">/</span>
      <span className="here">{here}</span>
    </div>
  )
  if (!guide) return <>{crumbs(g.ui.notFound)}<div className="notice">{g.ui.notFound}</div></>

  const title = g.articles[guide.slug].title
  const article = guide.build(g)
  const prev = GUIDES[index - 1]
  const next = GUIDES[index + 1]
  return (
    <>
      {crumbs(title)}
      <div className="page-head"><h1>{title}</h1></div>
      <p className="guide-lead"><Rich text={article.lead} /></p>
      <SectionNav sections={article.sections.map((section) => ({ id: section.id, label: section.title }))} />
      {article.sections.map((section) => (
        <section key={section.id} id={section.id} className="card guide-section">
          <h2 className="guide-h2">{section.title}</h2>
          {section.body}
        </section>
      ))}
      <nav className="guide-pager">
        {prev && (
          <Link to={`/guides/${prev.slug}`} className="prev">
            <span className="l">← {g.ui.prev}</span>
            {g.articles[prev.slug].title}
          </Link>
        )}
        {next && (
          <Link to={`/guides/${next.slug}`} className="next">
            <span className="l">{g.ui.next} →</span>
            {g.articles[next.slug].title}
          </Link>
        )}
      </nav>
    </>
  )
}
