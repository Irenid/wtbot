# Уведомления об исходном коде сторонних авторов

Исходный код wtbot и frontend распространяется по GNU AGPL-3.0-or-later; полный текст находится в [LICENSE](LICENSE). Сторонние авторские права и разрешения сохраняются. Изменения портированного кода выполнены участниками wtbot в 2026 году.

## wrpl-inspector

- Правообладатель оригинала: Copyright (C) 2025 flexcoral.
- Лицензия оригинала: GNU AGPL, версия 3 или любая более поздняя.
- Источник: https://github.com/maxsupermanhd/wrpl-inspector/tree/v3
- Порты и адаптации: `src/wrpl/blk.ts`, `src/wrpl/bit-reader.ts`, `src/wrpl/packet-stream.ts`, `src/wrpl/ecs.ts`, `src/wrpl/replay-events.ts`.
- Это изменённые версии соответствующих Go-реализаций; адаптация к TypeScript и архитектуре wtbot выполнена в 2026 году. Оригинальные уведомления и условия AGPL сохранены в этом файле и в указанных исходниках.

## WrplReplayParser

Портированная часть `src/wrpl/gm-sync.ts` опирается на `replay/mpi/PositionSync.cpp`. Источник: https://github.com/LivingTheDagor/WrplReplayParser . Права на оригинал и полный текст BSD-3-Clause:

```text
BSD 3-Clause License

Copyright (c) 2025, LivingTheDagor

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Dagor Engine

`src/wrpl/gm-sync.ts` также использует алгоритмы delta/RLE из Dagor Engine. Источник: https://github.com/GaijinEntertainment/DagorEngine . Права на оригинал и полный текст применимого BSD-3-Clause уведомления:

```text
Dagor Engine 

BSD 3-Clause License

Copyright (c) 2023, Gaijin Entertainment
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Границы лицензии исходного кода

Лицензия wtbot не заменяет лицензии npm-зависимостей. Их условия находятся в установленных пакетах и metadata lock-файлов. Лицензии runtime-пакетов, включаемых во frontend bundle, приведены в `frontend/public/THIRD_PARTY_NOTICES.txt`.

Указание `klensy/wt-tools` в `src/wrpl/vromfs.ts` относится к описанию бинарного формата; Python-код проекта в этом репозитории не распространяется.

GNU AGPL на код wtbot не предоставляет прав на игровые шрифты, карты, иконки, WRPL-файлы в `benchmarks/fixtures/replays/` и другие материалы третьих лиц. Их распространение и использование требуют самостоятельного основания.
