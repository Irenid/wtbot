# Tactical maps from the game files

The bot draws each mission's tactical maps as the game does, from the local
War Thunder client (`src/tactical-map/`): the ground map of the respawn screen
(ground heatmaps, the site's battle player) and the air map (air heatmaps, the
player's air view). Measured on game build 2026-10-08 (`linux64/aces` BuildID
`8cafa21a…`) against 160 in-game snapshots from wt-tools
(`data/maps/<map>__<mode>.png`, captured at 2560×1440, map 1153 px; ground maps
only, no air snapshots exist). Commands: `npm run maps:build -- [--kind air]
[--compare]` (`--help` in the file header of `src/analysis/tactical-maps.ts`).

## Sources

| What | File | Format |
|---|---|---|
| Map texture | `content/base/res/locations_maps.dxp.bin`: `<level>_tankmap` (ground), `<level>_map` (air), 465 textures | DxP2 pack of DDSx, DXT1/DXT5, Oodle Leviathan (`FLG_OODLE`); 1024² (four 4096² with `FLG_REV_MIP_ORDER`) |
| HQ texture (optional) | `content.hq/hq_tex/res/hq_tex_locations_maps.dxp.bin` (the launcher's high-quality textures, 251 MB) | the same names at 2048², one mip (`FLG_HQ_PARTIAL` 0x80000): every squadron level's tank and air map; empty (0×0) where the base pack has 4096² (`avg_ireland_tankmap`, `avg_falklands_*`) |
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
465 textures). Decoding a 2048² texture takes 55–70 ms; unpacking
`aces.vromfs.bin` 170 ms and ~130 MB, so a worker releases the archives after
60 s unused.

## Frame and grid (static analysis, all 158 snapshots within 3 px)

- Level loader `0x266f570`: `tankMapCoord0/1` (texture rect, default ±15000),
  `tankGridZeroPoint` (default the rect's north-west corner; one at or below
  its south edge falls back, "numY < 0" `0x266ffe3`), `tankGridSize` (default
  the rect), `tankGridSteps` (default 1: no grid). With
  `useAlternativeMapCoord` (after the mission's difficulty override; only
  arcade sets it) a key of the level's `alternativeMapCoord` wins.
- The air map, the same loader's airplane record (`this+0x5158`):
  `mapCoord0/1`, `gridZeroPoint` (same fallback, `0x2670044`), `gridSteps`
  (default 2000), texture `customLevelMap` or `<level>_map`, `mapColorMult`.
  It reads no size key: the grid spans the whole rect (`0x266fb5f`).
- `missionBattleArea` (`0x1d80440`): every ground + mapArea area, any team,
  joins one XZ box (`0x266ef00`): grid zero = its north-west corner, size =
  its extent; air + airMapArea areas (flags `0x401`) do the same for the air
  map. The parser sets `air` unless the action says `air: false`. The loader
  keeps an area's tm axes a, b, c; its XZ bounds (`0x1e3f1f0`): a box or
  cylinder spans the rotated unit cube (half extent 0.5·Σ|axis|), a cylinder
  at least its radius |a| (finland, breslau conq, northern india), a sphere
  ±0.5·max(|a|, |b|, |c|). Five squadron missions
  set no ground area (krymsk conq1–3, karelia dom and conq3) and keep the
  level grid; no squadron mission marks an air area (`air: false`), so its air
  map is the level's.
- Step (`0x266d6e0`): `newGridHorizontalCellCount` > 0 → size / cells;
  else m = the longer side, step = floor(m / (cells(m)·unit(m)))·unit(m),
  tables lerped by m: cells 7 (10 from 5000 m), unit 5 / 10 (300 m) / 25
  (1400) / 50 (2600) / 100 (10000). 1300 → 180, 1400 → 200, 1680 → 225;
  air maps 32 768 → 3200 (33 missions), 65 536 → 6500 (146), 131 072 → 13 100
  (14).
- View: a square of the grid's longer side around its centre, moved back
  inside the texture rect when it overhangs (berlin_conq1: 76.6 m west; the
  grid stays anchored, so the first column is 68 px wide).
- Lattice lines across the whole view; labels at the cells whose centre is
  inside the view, columns `1…` and rows `a…` counted from the first such cell.
  A crop of a map (an air heatmap's view) keeps the whole map's cell names.
- Texture: u = (x − x0)/(x1 − x0), v = (z1 − z)/(z1 − z0), bilinear (bicubic
  matched the snapshots' sharpness but not their RMSE).

## Mission objects

The squadron templates build the mission at `initMission`: `dom_init` /
`conq…_init` set base names, the difficulty check appends `_realistic` when
those areas and squads exist, else `_arcade`, then `missionBattleArea`,
`missionMarkAsCaptureZone` (letters in marking order), `missionMarkAsRespawnPoint`
(area_squad members). `src/tactical-map/mission.ts` runs this chain: a
trigger's actions in file order (the BLK reader keeps it, `BLK_ORDER`), its
enabled triggers after them, before its siblings (depth first), so
air_spawn_template's rank checks each mark their own spawn; triggers inside
categories (editor folders, `isCategory`) run in place. Comparisons are
`equal`, `notEqual`, `less`, `more`, `notLess`, `notMore`; `var_value_other`
compares with another variable.

- Imports load only when their conditions hold (`importApplies`):
  `rankRange` [min, max] holds the balance level (`missionGetBalanceLevel`:
  economic rank, (BR − 1)·3; the bot takes the cap the battle played:
  `battleBalanceLevel` by `stageAt` of `src/clan-season.ts`, whose
  `STAGE_SWITCH_DELAY_SEC` keeps a stage's first 01:00–07:00 UTC window on
  the previous cap) —
  each map's airfields of ranks 0–20 and 21–50, helipads from 20, decor that
  draws nothing; `difficulty` (`arcade`, `realistic`, `hardcore`: battle and
  kill areas of 24 missions on 8 maps; the realistic files name their own
  areas, so the ground maps stay byte-identical); `importByParameter`
  `isWorldWar` (the zonedef anti-tank guns: 22 templates, 27 missions) only
  when the descriptor sets it.
- Squadron battles force the airfield spawn: the server's session descriptor
  (`fromDescriptor`; neither the client nor the replay has it) sets
  `force_plane_airfield_spawn`, so `rb_only_bombers_air_spawn` marks the
  `_arcade` air spawns for bombers (`type_longrange_bomber`, `type_bomber`)
  and every other aircraft starts on the runway (`t1_airfield`) at any rank;
  the rank checks (< 20 `_arcade`, ≥ 20 `_hardcore`, ≥ 32 `_top`) never run.
  First track points of 125,942 aircraft (26,349 battles, BR caps 8.0–10.0)
  against every candidate object: slow at a runway end (1,633 m from the
  airfield object, p10–p90 1,631–1,636) or on a helipad (98 m), fast at an
  `_arcade` spawn (median 128 m), none at `_hardcore` or `_top`.
  `SQUADRON_BATTLE_DESCRIPTOR` (model.ts) sets it.
- The maps change at ranks 20 (helipads), 21 (airfields) and 26 (UCAV) and at
  no other (193 missions built at 0–50): `BALANCE_LEVEL_THRESHOLDS` start the
  cache buckets, and a build warns when its mission changes inside one.
- Helipads are `units.objectGroups` (`t1_helipad`, `t1_helipad_farspawn`, …:
  4 per mission), airfields too (`t1_airfield`: 2); from rank 26
  (`ucav_min_mrank`) `duplicateAreaAtPos` copies `spawn_ucav` 6 km ahead of the
  near helipad (`posOffset` [6000, 3000, 0] in its axes) for each team, and the
  following mark reads the copy's name: the template alternates the two
  actions, which only file order keeps apart.
- `battlearea_exclude_template` marks a squad of boxes as kill areas for both
  teams; `team_killareas_template` adds per-team detection areas around the
  spawns: `t1_killarea`, team A's spawn zone, belongs to team B, which shows
  on A's minimap inside it (`HUD_IS_VISIBLE_BY_ZONE`); simulator battles make
  them kill areas. Every squadron mission has them: 518 areas, 28 boxes, the
  rest cylinders and spheres; the shapes of 25 teams' zones overlap.
- An area's footprint is the game's point test in the area's frame
  (`0x1e3f3a0`, y ignored on the ground): a box |x|, |z| ≤ 0.5, a cylinder
  x² + z² < 1, a sphere |p|² ≤ 0.25. So a cylinder covers the ellipse
  p + cos t·a + sin t·c and a sphere half of it: 67 kill cylinders and the 54
  sphere detection areas of 28 missions are ellipses (american_valley:
  |a| 777, |c| 1388 → semi-axes 389 and 694 m).
- Which replay team starts at which mission team's spawn varies (40 battles:
  18 and 22), so both perspectives are built and the renderer picks by the
  team's first ground positions (in the air heatmaps too).

## Drawing (measured on the snapshots)

UI sizes are 1080p pixels; the 1153 px map is 864.75 of them (scale 4/3 at
1440p). Constants live in `src/tactical-map/render.ts` `GAME_MAP_STYLE`.

| Layer | Rule |
|---|---|
| Tone | out = 0.94·texel − 3.5 per channel (berlin_conq1, 428k pixels; a 108-map fit scored worse) |
| Hatch | outside the team's allowed areas or inside its kill areas (ground areas on the tank map, air areas on the air map: none in squadron missions): stripes along x − y, period 16 texels of screen height / 1000 px (23.03 px along x at 1440p on every snapshot). The game blends RGB (255, 75, 0) at 30/255 over half of each period (`battleAreaColorPresets.battleArea`), too faint on the heatmaps; ours (owner, 2026-10-22): lines over a fifth of the period at 85%, from (245, 50, 40) over dark ground to (170, 15, 15) over light (OKLab L 0.45–0.75, the ground's mean over one-period blocks) |
| Grid | black at 80/255 (`gridColor`), 1.3 UI px, on pixel centres |
| Detection zones | not the game's drawing (it outlines a zone only near a player): each team's spawn zone, the other team's detection areas, as one dashed outline of their union in the spawning team's colour, 1.5 UI px, dash 8/4, opaque; tank map only |
| Labels | PT Sans 18 UI px, black; column baseline 18.75 UI px; row letters centred at 10.6 UI px, baseline 7.6 below the cell centre |
| Zones | `basezone_small_mark_<letter>.svg` 21 UI px |
| Bases | the hud.blk icon of the kind (`objective_tank`, `_fighter`, `_bomber`, `_helicopter`, `_ucav` 36 UI px with a black outline icon at 45%; `objective_airfield` 45×25) at the mean of the base's areas merged within 200 m (`minDistBetweenZonesOnRespawnBases`; aircraft 2000 m), own #054AFB, enemy #F61914 (the yellow brackets are the respawn screen's selection). The tank map draws tank bases, the air map every kind: a base without tags is a fighter, `isAirfield` a runway or, with helicopter tags, a helipad |
| Scale | the last whole lattice cell left of the right edge, bar 2.25 UI px, "<step> m" |

Icon centres match the snapshots within 1 px. Not drawn yet: the arrows to
bases outside the view (`arrow_mark.svg`; ROADMAP has what is known). The air
map's base icons follow the tank map's rules; with no air snapshot they are
unverified.

## Air maps

`ensureGameAirMap` caches a mission's air map as its spec
(`src/tactical-map/spec.ts`: frame, grid, zones, bases, the icons' SVG), built
once per game version and rank bucket; the worker that needs a view draws it
(`composeTacticalMap`) with only the texture read from the pack:

- Air heatmaps: the view of the heatmap's map square (the flights plus the
  battle area, 6% margin, `WT_HEATMAP_AIR_*`) at 1400 px (2800 for HD), in the
  roster's perspective; the ground map stays inset at the battle area, so the
  air map leaves out its tank bases and zones there. 0.2–0.7 s per view.
  `WT_HEATMAP_AIR_SHOW_AIRFIELDS=false` hides airfields and helipads,
  `_SHOW_SPAWNS=false` air spawns and UCAVs.
- The site's battle player: the scene's air view (`map.air`, a square around
  every air track and the ground view, at least 8 km, the heatmaps' margin),
  saved with the scene and drawn at 1400 px on the first `map.png?kind=air`
  (the player's map control), in the ground map's perspective or, without
  one, by the air map's tank bases.

A spec is cached only when its texture is installed, and the worker falls back
to the level map captured from port 8111 when drawing fails. An unreadable HQ
pack is skipped for the base pack.

Flights span a median 27% of the air map's side (p90 49%, 400 battles,
2026-10-12): the whole map would leave them a quarter of the image.

## Results

`npm run maps:build -- --db <copy.db> --compare` on 2026-10-12: 193 missions in
19 s on 26 threads, 0 failures; RMSE against the 160 snapshots (both
perspectives, the closer one) with the base textures median 12.33, ≤ 12 for 73
(the bare texture crop: 16.2), with the HQ textures 12.65, ≤ 12 for 68 (43
closer, 109 further). The captures mix both qualities: american_valley_conq3 is
as sharp as the HQ texture (10.86 → 8.63), abandoned_town_conq2 as blurry as
the base one (13.31 → 15.80). The bot draws the HQ texture when the pack is
installed, as the game does. The largest errors are maps repainted since their
snapshot (same layout, other colours): ardennes, ardennes_snow,
stalingrad_factory, ireland, karpaty, arctic, aral sea. `--kind air` draws the
193 air maps in 12 s.

On 2026-10-15 (`TACTICAL_MAP_VERSION` 4, HQ textures, baseline median 12.68,
≤ 12 for 68): the footprints as the game tests them move 9 snapshots closer
(arctic, sinai, eastern_europe, karpaty: 0.01–0.10) and none further; the
detection zone outlines, absent from the game's map, raise the median to 12.92
(≤ 12 for 66).

Air bases against the flights (2026-10-13): of 230,242 aircraft in 49,771
battles (2026-07-15..10-12, BR caps 8.0–10.7), every first track point lies
within 3 km of a drawn base (98.6% within 2 km; air spawns median 127 m,
runways 1,633 m: the runway end), against 48.8% (33.6%) with the maps before
the import conditions and the squadron descriptor (median 3,044 m). The ground
maps stayed byte-identical. At cap 7.0 (balance level 18, bucket 0; 2,449
battles 2026-10-13..15, 13,981 aircraft): 99.99% within 3 km (runways median
721 m: the low-rank airfields' shorter runways; air spawns 127 m), every
ground vehicle within 150 m of a tank base. The stage's first 01:00–07:00 UTC
window (59 battles) still played cap 8.0 (A-4H, L-39ZA, Mi-8TB) from the
rank-21 airfields and helipads; drawn by the unshifted stage, 0.6% of the
week's aircraft started 5–11 km from a drawn base.

## Cache

`data/maps/game/<mission>-<team>-r<rank bucket>-<size>-<hash>.jpg` (JPEG 92,
~0.5 MB at 1400 px) plus `.json` meta (view, grid, zones, bases of every kind),
and `<mission>-air-r<rank bucket>-<hash>.json`, the air map's spec (~50 KB);
the hash covers `TACTICAL_MAP_VERSION` and the sizes and mtimes of the source
files (the HQ pack's absence too), so a game patch rebuilds and the
mission's files of an older hash are deleted (`pruneStaleMaps`: any team,
bucket and size). Heatmaps use 1400 px (2800 for HD), the site's battle
player 1400 px; its air view is `data/battles/<session>-scene-v<N>-air.json`
(the view; N = `BATTLE_SCENE_VERSION`) and `-air.jpg` (drawn), in the battle
cache's LRU.
