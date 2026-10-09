# oodle-wasm

`src/tactical-map/oodle.wasm`: the Oodle decompressor (Kraken, Mermaid, Selkie,
Leviathan) for the game's textures, built from
[oozextract](https://crates.io/crates/oozextract) 0.5.5, a Rust port of
[ooz](https://github.com/powzix/ooz) (Copyright (C) 2016 Powzix,
GPL-3.0-or-later; see `LICENSES/README.md`).

`src/lib.rs` exposes a C ABI without imports: `buffer_alloc(len)`,
`buffer_free(ptr, len)` and `decompress(src, src_len, dst, dst_len)` → decoded
length or -1; `src/tactical-map/oodle.ts` drives it.

Rebuild (Docker): `tools/oodle-wasm/build.sh`. Checks: `npm test`
(`tactical-map.test.ts` decodes stored blocks) and
`npm run maps:build -- --compare` on an installed game (decodes every map
texture).
