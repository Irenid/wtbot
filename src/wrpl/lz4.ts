/**
 * Распаковка блока LZ4 (не frame!) — ECS-пакеты реплея сжаты именно
 * блоками. Стандартный алгоритм: токен = (длина литералов << 4) | длина
 * совпадения, длины 15 расширяются байтами 255, смещение u16 LE.
 */
export function lz4DecompressBlock(src: Buffer, maxOut: number): Buffer {
  if (!Number.isSafeInteger(maxOut) || maxOut < 0) {
    throw new RangeError('LZ4: maxOut должен быть неотрицательным целым')
  }
  const out = Buffer.alloc(maxOut)
  let s = 0
  let d = 0
  while (s < src.length) {
    const token = src[s++]!
    let litLen = token >> 4
    if (litLen === 15) {
      let b: number
      do {
        if (s >= src.length) throw new Error('LZ4: обрезана длина литералов')
        b = src[s++]!
        litLen += b
      } while (b === 255)
    }
    if (d + litLen > out.length || s + litLen > src.length) throw new Error('LZ4: литералы вне буфера')
    src.copy(out, d, s, s + litLen)
    s += litLen
    d += litLen
    if (s >= src.length) break // последняя последовательность — без совпадения

    if (s + 2 > src.length) throw new Error('LZ4: обрезано смещение')
    const offset = src[s]! | (src[s + 1]! << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error('LZ4: неверное смещение')
    let matchLen = (token & 0x0f) + 4
    if ((token & 0x0f) === 15) {
      let b: number
      do {
        if (s >= src.length) throw new Error('LZ4: обрезана длина совпадения')
        b = src[s++]!
        matchLen += b
      } while (b === 255)
    }
    if (d + matchLen > out.length) throw new Error('LZ4: совпадение вне буфера')
    // Копирование по байту: source может перекрываться с назначением
    let m = d - offset
    for (let i = 0; i < matchLen; i++) out[d++] = out[m++]!
  }
  return out.subarray(0, d)
}
