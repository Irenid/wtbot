# Third-party code licenses

wtbot is GNU AGPL-3.0-or-later ([LICENSE](../LICENSE)). This directory holds
the full license texts of ported code: they must travel with the sources and
builds (the Docker image copies `LICENSES/*.txt`).

| File | Origin | Original license |
| --- | --- | --- |
| `src/wrpl/gm-sync.ts` | [WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser), `replay/mpi/PositionSync.cpp` | [BSD-3-Clause](BSD-3-Clause-WrplReplayParser.txt) |
| `src/wrpl/gm-sync.ts` | [Dagor Engine](https://github.com/GaijinEntertainment/DagorEngine), delta/RLE | [BSD-3-Clause](BSD-3-Clause-DagorEngine.txt) |
| `src/wrpl/blk.ts`, `bit-reader.ts`, `packet-stream.ts`, `ecs.ts`, `replay-events.ts` | [wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector) (Copyright (C) 2025 flexcoral) | AGPL-3.0-or-later, same as wtbot — [LICENSE](../LICENSE) |

Licenses of the npm packages and the font in the frontend bundle —
`frontend/public/THIRD_PARTY_NOTICES.txt`. The wtbot license grants no rights
to the game fonts, maps, icons and WRPL files in `benchmarks/fixtures/replays/`:
they belong to third parties.
