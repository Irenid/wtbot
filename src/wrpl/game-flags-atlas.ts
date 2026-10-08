import type { VromfsFile } from './vromfs.js'

/**
 * The flag SVGs of the game's atlas (ui/atlases.vromfs.bin), by name:
 * `country_<name>.svg`, and the Republic of China's service flag, the only
 * operator flag outside them (`flag_republic_china.svg`).
 */
export function atlasFlags(files: readonly VromfsFile[]): [string, string][] {
  const flags: [string, string][] = []
  for (const file of files) {
    const match = /^gameuiskin\/(?:country_([^/]+)|flag_(republic_china))\.svg$/i.exec(file.name)
    if (match) flags.push([(match[1] ?? match[2])!.toLowerCase(), file.data.toString('utf8')])
  }
  return flags
}
