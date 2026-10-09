# Third-party code licenses

wtbot is GNU AGPL-3.0-or-later ([LICENSE](../LICENSE)). This directory holds
the full license texts of ported code: they must travel with the sources and
builds (the Docker image copies `LICENSES/*.txt`).

| File | Origin | Original license |
| --- | --- | --- |
| `src/wrpl/gm-sync.ts` | [WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser), `replay/mpi/PositionSync.cpp` | [BSD-3-Clause](BSD-3-Clause-WrplReplayParser.txt) |
| `src/wrpl/gm-sync.ts` | [Dagor Engine](https://github.com/GaijinEntertainment/DagorEngine), delta/RLE | [BSD-3-Clause](BSD-3-Clause-DagorEngine.txt) |
| `src/wrpl/blk.ts`, `bit-reader.ts`, `packet-stream.ts`, `ecs.ts`, `replay-events.ts` | [wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector) (Copyright (C) 2025 flexcoral) | AGPL-3.0-or-later, same as wtbot — [LICENSE](../LICENSE) |
| `src/wrpl/blk.ts` (slim BLK), `src/wrpl/vromfs.ts` (shared name map), `src/tactical-map/dxp.ts` (DxP2, DDSx) | [Dagor Engine](https://github.com/GaijinEntertainment/DagorEngine) formats: `blk_serialize.cpp`, `blk_zstd.cpp`, `texPackMgr2.cpp`, `ddsxTex.h` | [BSD-3-Clause](BSD-3-Clause-DagorEngine.txt) |
| `src/tactical-map/oodle.wasm`, built by `tools/oodle-wasm/` | [oozextract](https://crates.io/crates/oozextract) 0.5.5 (its crate metadata says MIT), a Rust port of [ooz](https://github.com/powzix/ooz) (Copyright (C) 2016 Powzix) | GPL-3.0-or-later, the license of ooz — [GPL-3.0-ooz.txt](GPL-3.0-ooz.txt); compatible with AGPL-3.0 (§13 of both) |

Licenses of the npm packages and the font in the frontend bundle —
`frontend/public/THIRD_PARTY_NOTICES.txt`. The wtbot license grants no rights
to the game fonts, maps, icons and WRPL files in `benchmarks/fixtures/replays/`:
they belong to third parties.
