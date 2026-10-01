const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
  nbsp: ' ',
}

/**
 * Снимает HTML-экранирование текста со страниц и из API warthunder.com:
 * числовые (&#039;, &#x27;) и основные именованные сущности за один проход,
 * поэтому «&amp;lt;» становится «&lt;», а не «<». Недопустимый код символа
 * остаётся как есть и не роняет разбор.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase()
    if (!lower.startsWith('#')) return NAMED_ENTITIES[lower] ?? entity
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1))
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    return valid ? String.fromCodePoint(code) : entity
  })
}
