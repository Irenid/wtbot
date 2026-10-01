import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorkerRenderFontProfile } from './protocol.js'

interface UiFontCandidate {
  defaultFamily: string
  source: WorkerRenderFontProfile['source']
  files: string[]
}

interface UiFontSet extends UiFontCandidate {
  files: string[]
}

interface ScriptFontCandidate {
  pattern: RegExp
  files: string[]
  available: boolean
}

export interface ResolvedRenderFonts extends WorkerRenderFontProfile {
  fontFiles: string[]
}

let cachedUiFontSet: UiFontSet | undefined
let cachedScriptFontCandidates: ScriptFontCandidate[] | undefined
let cachedSymbolFallbackFiles: string[] | undefined

/**
 * Resvg создаёт отдельную font database для каждого экземпляра. Передаём ему
 * небольшой известный набор UI-шрифтов вместо повторного сканирования всей ОС.
 *
 * Порядок файлов — это порядок поиска запасного шрифта. Resvg раскладывает
 * весь текстовый фрагмент шрифтом каждого tspan, недостающий символ берёт из
 * первого шрифта базы, где он есть, и, если тот покрывает весь фрагмент,
 * заменяет им все глифы. Поэтому свои шрифты (шрифт игры) идут сразу за
 * UI-шрифтом: рамки клан-тегов и значки в названиях техники остаются игровыми
 * глифами, а буквы рядом — UI-шрифтом своего начертания. Широкий символьный
 * запас — последним, чтобы не перехватывать эти символы.
 */
export function resolveRenderFonts(
  customFontFiles: readonly string[],
  svg: string,
): ResolvedRenderFonts {
  const ui = cachedUiFontSet ??= resolveUiFontSet()
  const scripts = resolveScriptFonts(svg)
  const custom = uniquePaths(customFontFiles)
  const symbols = cachedSymbolFallbackFiles ??= symbolFallbackFiles()
  return {
    fontFiles: uniquePaths([...ui.files, ...custom, ...scripts.files, ...symbols]),
    loadSystemFonts: ui.files.length === 0 || scripts.missing,
    defaultFamily: ui.defaultFamily,
    source: ui.source,
    uiFileCount: ui.files.length,
    scriptFileCount: scripts.files.length,
    customFileCount: custom.length,
    missingScriptFallback: scripts.missing,
  }
}

function resolveScriptFonts(svg: string): { files: string[]; missing: boolean } {
  const candidates = cachedScriptFontCandidates ??= scriptFontCandidates()
  const requiresScriptFont = /[\u1100-\u11ff\u3000-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(svg)
  if (!requiresScriptFont) return { files: [], missing: false }

  const files: string[] = []
  let matched = false
  let missing = false
  for (const candidate of candidates) {
    if (!candidate.pattern.test(svg)) continue
    matched = true
    if (!candidate.available) missing = true
    else files.push(...candidate.files)
  }
  return { files: uniquePaths(files), missing: missing || !matched }
}

function resolveUiFontSet(): UiFontSet {
  for (const candidate of platformCandidates()) {
    const files = candidate.files.filter((file) => existsSync(file))
    // Первый файл в наборе всегда regular face и определяет пригодность family.
    if (files[0] === candidate.files[0]) return { ...candidate, files }
  }

  // Неизвестная/minimal ОС сохраняет прежнюю корректность ценой системного scan.
  return {
    defaultFamily: process.platform === 'win32' ? 'Segoe UI' : 'sans-serif',
    source: 'system-fallback',
    files: [],
  }
}

function platformCandidates(): UiFontCandidate[] {
  if (process.platform === 'win32') {
    const fontsDir = windowsFontsDirectory()
    return [
      candidate(fontsDir, 'Segoe UI', 'win32-segoe-ui', [
        'segoeui.ttf',
        'segoeuib.ttf',
        'seguisb.ttf',
        'seguisym.ttf',
      ]),
      candidate(fontsDir, 'Arial', 'win32-arial', [
        'arial.ttf',
        'arialbd.ttf',
      ]),
    ]
  }

  if (process.platform === 'linux') {
    // Noto Sans первым: в нём, как и в Segoe UI, нет box-drawing (U+2500–257F),
    // которыми в реплее записаны рамки клан-тегов. DejaVu и Liberation их
    // содержат, и Resvg рисует рамки ими вместо глифов шрифта игры.
    return [
      candidate('/usr/share/fonts/truetype/noto', 'Noto Sans', 'linux-noto-sans', [
        'NotoSans-Regular.ttf',
        'NotoSans-Bold.ttf',
      ]),
      candidate('/usr/share/fonts/truetype/dejavu', 'DejaVu Sans', 'linux-dejavu-sans', [
        'DejaVuSans.ttf',
        'DejaVuSans-Bold.ttf',
      ]),
      candidate('/usr/share/fonts/truetype/liberation2', 'Liberation Sans', 'linux-liberation-sans', [
        'LiberationSans-Regular.ttf',
        'LiberationSans-Bold.ttf',
      ]),
    ]
  }

  if (process.platform === 'darwin') {
    return [
      candidate('/System/Library/Fonts/Supplemental', 'Arial', 'darwin-arial', [
        'Arial.ttf',
        'Arial Bold.ttf',
      ]),
    ]
  }

  return []
}

function scriptFontCandidates(): ScriptFontCandidate[] {
  const han = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
  const japanese = /[\u3040-\u30ff]/u
  const korean = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u

  if (process.platform === 'win32') {
    const fontsDir = windowsFontsDirectory()
    return [
      scriptCandidate(han, joinFiles(fontsDir, ['msyh.ttc', 'msyhbd.ttc'])),
      scriptCandidate(japanese, joinFiles(fontsDir, ['YuGothR.ttc', 'YuGothB.ttc'])),
      scriptCandidate(korean, joinFiles(fontsDir, ['malgun.ttf', 'malgunbd.ttf'])),
    ]
  }

  if (process.platform === 'linux') {
    const files = joinFiles('/usr/share/fonts/opentype/noto', [
      'NotoSansCJK-Regular.ttc',
      'NotoSansCJK-Bold.ttc',
    ])
    return [
      scriptCandidate(han, files),
      scriptCandidate(japanese, files),
      scriptCandidate(korean, files),
    ]
  }

  if (process.platform === 'darwin') {
    return [
      scriptCandidate(han, ['/System/Library/Fonts/PingFang.ttc']),
      scriptCandidate(japanese, ['/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc']),
      scriptCandidate(korean, ['/System/Library/Fonts/AppleSDGothicNeo.ttc']),
    ]
  }

  return []
}

/**
 * Символы, которых нет ни в UI-шрифте, ни в шрифте игры (☭ на нарисованном
 * флаге СССР). На Windows эту роль играет Segoe UI Symbol из UI-набора.
 */
function symbolFallbackFiles(): string[] {
  if (process.platform !== 'linux') return []
  return joinFiles('/usr/share/fonts/truetype/dejavu', ['DejaVuSans.ttf'])
    .filter((file) => existsSync(file))
}

function windowsFontsDirectory(): string {
  return path.join(process.env['WINDIR']?.trim() || 'C:\\Windows', 'Fonts')
}

function joinFiles(directory: string, names: readonly string[]): string[] {
  return names.map((name) => path.join(directory, name))
}

function scriptCandidate(pattern: RegExp, candidates: readonly string[]): ScriptFontCandidate {
  const files = candidates.filter((file) => existsSync(file))
  return { pattern, files, available: files[0] === candidates[0] }
}

function candidate(
  directory: string,
  defaultFamily: string,
  source: WorkerRenderFontProfile['source'],
  names: readonly string[],
): UiFontCandidate {
  return { defaultFamily, source, files: joinFiles(directory, names) }
}

function uniquePaths(files: readonly string[]): string[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const normalized = path.normalize(file)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
