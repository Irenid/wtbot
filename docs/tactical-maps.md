# Tactical maps from the game files

The bot draws each mission's tactical map as the game's respawn screen shows
it, from the local War Thunder client (`src/tactical-map/`). Measured on game
build 2026-10-08 (`linux64/aces` BuildID `8cafa21a…`) against 160 in-game
snapshots from wt-tools (`data/maps/<map>__<mode>.png`, captured at 2560×1440,
map 1153 px). Commands: `npm run maps:build -- [--compare]` (`--help` in the
file header of `src/analysis/tactical-maps.ts`).

## Sources

| What | File | Format |
|---|---|---|
| Map texture | `content/base/res/locations_maps.dxp.bin`: `<level>_tankmap` (ground), `<level>_map` (air), 465 textures | DxP2 pack of DDSx, DXT1/DXT5, Oodle Leviathan (`FLG_OODLE`); 1024² (four 4096² with `FLG_REV_MIP_ORDER`) |
| Level frame and grid | `aces.vromfs.bin` `levels/<level>.blk` | slim BLK (label 5: zstd with the archive's dictionary, shared name map `\xff?nm`) |
| Grid step tables | `aces.vromfs.bin` `config/gameplay.blk` `tacticalMap.cellCount`, `gridStepDiv` | slim BLK |
| Map style | `aces.vromfs.bin` `config/hud.blk` `tacticalMap`, `battleAreaColorPresets` | slim BLK; colours are E3DCOLOR bytes B, G, R, A |
| Missions | `mis.vromfs.bin` `gamedata/missions/…` and their imports | slim BLK |
| Icons | `ui/atlases.vromfs.bin` `gameuiskin/*.svg` (white, tinted by the draw colour) | plain VRFs |
| Hatch pattern | `ui/tex.vromfs.bin` `map_pattern_a.ddsx`: 16×16 A8R8G8B8, diagonal stripes, half opaque | DDSx, Oodle |
| Label font | `ui/fonts.vromfs.bin` `ttfs/pt_sans-web-regular-reducedheight.ttf` (`tiny_text_hud`, 18 px at `hRes.1080`, 24 at 1440) | TTF |

VROMFS: the u32 at 12 packs the size in its low 26 bits and the type in the
top 6 (0x30 zstd obfuscated, 0x10 without digest, 0x20 plain); 3-byte readings
break on images over 16 MiB (`aces.vromfs.bin`). Oodle: oozextract 0.5.5 as
WebAssembly (`tools/oodle-wasm`); npm `ooz-wasm` 2.0.0 fails on Leviathan (403 of
465 textures).

## Frame and grid (static analysis, all 158 snapshots within 3 px)

- Level loader `0x266f570`: `tankMapCoord0/1` (texture rect, default ±15000),
  `tankGridZeroPoint` (default the rect's north-west corner; one at or below
  its south edge falls back, "numY < 0" `0x266ffe3`), `tankGridSize` (default
  the rect), `tankGridSteps` (default 1: no grid). With
  `useAlternativeMapCoord` (after the mission's difficulty override; only
  arcade sets it) a key of the level's `alternativeMapCoord` wins.
- `missionBattleArea` (`0x1d80440`): every ground + mapArea area, any team,
  joins one XZ box (`0x266ef00`): grid zero = its north-west corner, size =
  its extent. Box areas scale the unit cube (half extent 0.5·Σ|axis|),
  cylinders and spheres the unit radius (finland, breslau conq, northern
  india). Five squadron missions set none (krymsk conq1–3, karelia dom and
  conq3) and keep the level grid.
- Step (`0x266d6e0`): `newGridHorizontalCellCount` > 0 → size / cells;
  else m = the longer side, step = floor(m / (cells(m)·unit(m)))·unit(m),
  tables lerped by m: cells 7 (10 from 5000 m), unit 5 / 10 (300 m) / 25
  (1400) / 50 (2600) / 100 (10000). 1300 → 180, 1400 → 200, 1680 → 225.
- View: a square of the grid's longer side around its centre, moved back
  inside the texture rect when it overhangs (berlin_conq1: 76.6 m west; the
  grid stays anchored, so the first column is 68 px wide).
- Lattice lines across the whole view; labels at the cells whose centre is
  inside the view, columns `1…` and rows `a…` counted from the first such cell.
- Texture: u = (x − x0)/(x1 − x0), v = (z1 − z)/(z1 − z0), bilinear (bicubic
  matched the snapshots' sharpness but not their RMSE).

## Mission objects

The squadron templates build the mission at `initMission`: `dom_init` /
`conq…_init` set base names, the difficulty check appends `_realistic` when
those areas and squads exist, else `_arcade`, then `missionBattleArea`,
`missionMarkAsCaptureZone` (letters in marking order), `missionMarkAsRespawnPoint`
(area_squad members). `src/tactical-map/mission.ts` runs this chain: a
trigger's enabled triggers fire after its actions, before its siblings (depth
first), so air_spawn_template's rank checks each mark their own spawn;
triggers inside categories (editor folders, `isCategory`) run in place.
Comparisons are `equal`, `notEqual`, `less`, `more`, `notLess`, `notMore`.

- Air spawns depend on `missionGetBalanceLevel` (economic rank, (BR − 1)·3):
  < 20 arcade fighters and bombers, ≥ 20 `_hardcore`, ≥ 32 also `_top`; the
  bot takes the battle's season stage cap.
- `battlearea_exclude_template` marks a squad of boxes as kill areas for both
  teams; `team_killareas_template` adds per-team detection areas.
- Which replay team starts at which mission team's spawn varies (40 battles:
  18 and 22), so both perspectives are built and the renderer picks by the
  team's first positions.

## Drawing (measured on the snapshots)

UI sizes are 1080p pixels; the 1153 px map is 864.75 of them (scale 4/3 at
1440p). Constants live in `src/tactical-map/render.ts` `GAME_MAP_STYLE`.

| Layer | Rule |
|---|---|
| Tone | out = 0.94·texel − 3.5 per channel (berlin_conq1, 428k pixels; a 108-map fit scored worse) |
| Hatch | outside the team's allowed areas or inside its kill areas: stripes along x − y, period 16 texels of screen height / 1000 px (23.03 px along x at 1440p on every snapshot), on-stripes blend RGB (255, 75, 0) at 30/255 (`battleAreaColorPresets.battleArea`) |
| Grid | black at 80/255 (`gridColor`), 1.3 UI px, on pixel centres |
| Labels | PT Sans 18 UI px, black; column baseline 18.75 UI px; row letters centred at 10.6 UI px, baseline 7.6 below the cell centre |
| Zones | `basezone_small_mark_<letter>.svg` 21 UI px |
| Bases | `objective_tank.svg` 36 UI px at the mean of the base's areas merged within 200 m (`minDistBetweenZonesOnRespawnBases`), own #054AFB, enemy #F61914, outline black at 45% (the yellow brackets are the respawn screen's selection) |
| Scale | the last whole lattice cell left of the right edge, bar 2.25 UI px, "<step> m" |

Icon centres match the snapshots within 1 px. Not drawn yet: the arrows to
bases outside the view (`arrow_mark.svg`; ROADMAP has what is known).

## Results

`npm run maps:build -- --db <copy.db> --compare` on 2026-10-09: 193 missions in
17 s on 26 threads, 0 failures; RMSE against the 160 snapshots (both
perspectives, the closer one) median 12.3, ≤ 12 for 73 (the bare texture
crop: 16.2). The large ones are
maps repainted since their snapshot (same layout, other colours): ardennes,
ardennes_snow, stalingrad_factory, ireland, karpaty, arctic, aral sea.

## Cache

`data/maps/game/<mission>-<team>-r<rank bucket>-<size>-<hash>.jpg` (JPEG 92,
~0.5 MB at 1400 px) plus `.json` meta (view, grid, zones, bases); the hash
covers `TACTICAL_MAP_VERSION` and the sizes and mtimes of the source files, so
a game patch rebuilds and the older variant is deleted. Heatmaps use 1400 px
(2800 for HD), the site's battle player 1400 px.
