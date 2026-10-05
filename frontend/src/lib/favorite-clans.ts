import { useSyncExternalStore } from 'react'

/**
 * The viewer's favourite squadrons: core tags in this browser's localStorage, shared by /clans and
 * the squadron page. Without storage (private mode, blocked site data) the list lives until the
 * tab closes.
 */
const STORAGE_KEY = 'wtbot-favorite-clans'
/** The API's limit for /api/clans?tags= (MAX_FILTER_TAGS in src/web/routes/site.ts). */
export const MAX_FAVORITE_CLANS = 50
/** A core tag as the server makes it (plainClanTag): letters and digits only. */
const CORE_TAG = /^[\p{L}\p{N}]{1,32}$/u
const EMPTY: readonly string[] = []

let current: readonly string[] | null = null
const listeners = new Set<() => void>()

function load(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return EMPTY
    const tags = parsed.filter((tag): tag is string => typeof tag === 'string' && CORE_TAG.test(tag))
    return [...new Set(tags)].slice(0, MAX_FAVORITE_CLANS)
  } catch {
    return EMPTY
  }
}

function snapshot(): readonly string[] {
  current ??= load()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab changed the list (key null — its storage was cleared).
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    current = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Favourite core tags in the order they were added. */
export function useFavoriteClans(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

/** Adds or removes a squadron; false — the list is full, nothing changed. */
export function toggleFavoriteClan(coreTag: string): boolean {
  const tags = snapshot()
  const next = tags.includes(coreTag) ? tags.filter((tag) => tag !== coreTag) : [...tags, coreTag]
  if (next.length > MAX_FAVORITE_CLANS || !CORE_TAG.test(coreTag)) return false
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked or full: the list still works in this tab.
  }
  for (const listener of listeners) listener()
  return true
}
