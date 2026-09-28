# Лицензии стороннего кода

Код wtbot распространяется по GNU AGPL-3.0-or-later ([LICENSE](../LICENSE)).
Здесь лежат полные тексты лицензий портированного кода, которые его авторы
требуют хранить вместе с исходниками и сборками.

| Файл | Происхождение | Лицензия оригинала |
| --- | --- | --- |
| `src/wrpl/gm-sync.ts` | [WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser), `replay/mpi/PositionSync.cpp` | [BSD-3-Clause](BSD-3-Clause-WrplReplayParser.txt) |
| `src/wrpl/gm-sync.ts` | [Dagor Engine](https://github.com/GaijinEntertainment/DagorEngine), delta/RLE | [BSD-3-Clause](BSD-3-Clause-DagorEngine.txt) |
| `src/wrpl/blk.ts`, `bit-reader.ts`, `packet-stream.ts`, `ecs.ts`, `replay-events.ts` | [wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector) (Copyright (C) 2025 flexcoral) | AGPL-3.0-or-later, как и wtbot — [LICENSE](../LICENSE) |

Лицензии npm-пакетов и шрифта во frontend bundle —
`frontend/public/THIRD_PARTY_NOTICES.txt`.

Лицензия wtbot не даёт прав на игровые шрифты, карты, иконки и WRPL-файлы в
`benchmarks/fixtures/replays/`: это материалы третьих лиц.
