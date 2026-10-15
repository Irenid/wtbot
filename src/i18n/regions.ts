/**
 * ISO 3166 regions of the game's flag icons (base ids without era suffixes,
 * as /scout's flagName strips them), so a catalog can name a country through
 * Intl.DisplayNames. Historical states without a region (USSR, GDR, Republic
 * of China, South Vietnam) are named by each catalog itself.
 */
export const FLAG_REGIONS: Readonly<Record<string, string>> = {
  argentina: 'AR',
  australia: 'AU',
  austria: 'AT',
  bangladesh: 'BD',
  belgium: 'BE',
  brazil: 'BR',
  britain: 'GB',
  canada: 'CA',
  china: 'CN',
  colombia: 'CO',
  cuba: 'CU',
  czech: 'CZ',
  denmark: 'DK',
  egypt: 'EG',
  finland: 'FI',
  france: 'FR',
  germany: 'DE',
  greece: 'GR',
  hungary: 'HU',
  india: 'IN',
  indonesia: 'ID',
  iran: 'IR',
  ireland: 'IE',
  israel: 'IL',
  italy: 'IT',
  japan: 'JP',
  jordan: 'JO',
  kazakhstan: 'KZ',
  kuwait: 'KW',
  lithuania: 'LT',
  malaysia: 'MY',
  netherlands: 'NL',
  new_zealand: 'NZ',
  north_korea: 'KP',
  norway: 'NO',
  oman: 'OM',
  pakistan: 'PK',
  philippines: 'PH',
  poland: 'PL',
  portugal: 'PT',
  romania: 'RO',
  russia: 'RU',
  saudi_arabia: 'SA',
  serbia: 'RS',
  singapore: 'SG',
  slovakia: 'SK',
  somalia: 'SO',
  south_africa: 'ZA',
  spain: 'ES',
  sweden: 'SE',
  switzerland: 'CH',
  syria: 'SY',
  thailand: 'TH',
  turkey: 'TR',
  uae: 'AE',
  usa: 'US',
  venezuela: 'VE',
  vietnam: 'VN',
}

/** A flag's country through Intl.DisplayNames in `intl`; null — no region or no name. */
export function regionName(names: Intl.DisplayNames, base: string): string | null {
  const region = FLAG_REGIONS[base]
  if (region === undefined) return null
  const name = names.of(region)
  return name && name !== region ? name : null
}
