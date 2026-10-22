import type { RgbaImage } from './dxp.js'
import type { GroundShape, MapBattleAreas, WorldRect } from './model.js'

/**
 * The map texture resampled to the output frame as the GPU draws it: texel
 * centres at +0.5, bilinear filtering, clamped edges; when one output pixel
 * covers more than a texel the texture is box-filtered first (the mip chain's
 * role). Image rows run north to south: texture row v = (z1 - z) / (z1 - z0),
 * column u = (x - x0) / (x1 - x0) over the texture's world rect. Outside it
 * the pixel is `background`.
 */
export function sampleFrame(
  texture: RgbaImage,
  textureRect: WorldRect,
  frame: WorldRect,
  size: number,
  background: [number, number, number, number] = [0, 0, 0, 255],
  colorMult: [number, number, number, number] = [255, 255, 255, 255],
): RgbaImage {
  const texelsPerPixel = ((frame.x1 - frame.x0) / (textureRect.x1 - textureRect.x0)) * texture.width / size
  const source = texelsPerPixel > 1.5 ? boxDownscale(texture, Math.floor(texelsPerPixel)) : texture
  const { width: tw, height: th, data: src } = source
  const out = Buffer.alloc(size * size * 4)
  const mult = colorMult.map((c) => c / 255)
  const sx = (frame.x1 - frame.x0) / size
  const sz = (frame.z1 - frame.z0) / size
  const tx = tw / (textureRect.x1 - textureRect.x0)
  const tz = th / (textureRect.z1 - textureRect.z0)
  for (let py = 0; py < size; py++) {
    const z = frame.z1 - (py + 0.5) * sz
    const v = (textureRect.z1 - z) * tz - 0.5
    for (let px = 0; px < size; px++) {
      const x = frame.x0 + (px + 0.5) * sx
      const o = (py * size + px) * 4
      if (x < textureRect.x0 || x > textureRect.x1 || z < textureRect.z0 || z > textureRect.z1) {
        out[o] = background[0]
        out[o + 1] = background[1]
        out[o + 2] = background[2]
        out[o + 3] = background[3]
        continue
      }
      const u = (x - textureRect.x0) * tx - 0.5
      const u0 = Math.floor(u)
      const v0 = Math.floor(v)
      const fu = u - u0
      const fv = v - v0
      const ua = Math.min(tw - 1, Math.max(0, u0))
      const ub = Math.min(tw - 1, Math.max(0, u0 + 1))
      const va = Math.min(th - 1, Math.max(0, v0))
      const vb = Math.min(th - 1, Math.max(0, v0 + 1))
      const i00 = (va * tw + ua) * 4
      const i10 = (va * tw + ub) * 4
      const i01 = (vb * tw + ua) * 4
      const i11 = (vb * tw + ub) * 4
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c]! + (src[i10 + c]! - src[i00 + c]!) * fu
        const bottom = src[i01 + c]! + (src[i11 + c]! - src[i01 + c]!) * fu
        out[o + c] = Math.round((top + (bottom - top) * fv) * mult[c]!)
      }
    }
  }
  return { width: size, height: size, data: out }
}

/** An integer-factor box filter (a mip level `factor` times smaller). */
function boxDownscale(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.floor(image.width / factor))
  const height = Math.max(1, Math.floor(image.height / factor))
  const out = Buffer.alloc(width * height * 4)
  const area = factor * factor
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0]
      for (let dy = 0; dy < factor; dy++) {
        const row = ((y * factor + dy) * image.width + x * factor) * 4
        for (let dx = 0; dx < factor; dx++) {
          for (let c = 0; c < 4; c++) sums[c]! += image.data[row + dx * 4 + c]!
        }
      }
      const o = (y * width + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sums[c]! / area)
    }
  }
  return { width, height, data: out }
}


/** Per-channel map tone of the respawn map: out = k·texel + d (measured on the snapshots, ≈7% darker). */
export type MapTone = [[number, number], [number, number], [number, number]]

export function applyTone(image: RgbaImage, tone: MapTone): void {
  const { data } = image
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const [k, d] = tone[c]!
      data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c]! * k + d)))
    }
  }
}

export interface HatchStyle {
  /** Line colours (RGB) over dark and over light ground; between them the colour follows the ground's lightness. */
  onDark: [number, number, number]
  onLight: [number, number, number]
  /** Ground lightness (OKLab L, 0–1) up to which a line takes onDark, and from which onLight. */
  lightness: [number, number]
  alpha: number
  /** Stripe period along x in output pixels; stripes run along x − y = const. */
  periodX: number
  /** Stripe phase: a stripe centre lies on x − y = phase (mod period). */
  phase: number
  /** The share of a period a line covers (the game's pattern: half). */
  duty: number
}

/** sRGB byte → linear light. */
const LINEAR = Array.from({ length: 256 }, (_, v) => (v <= 10.31475 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))

/**
 * The ground's lightness around each pixel: OKLab L of a grey as bright as the
 * mean colour of blocks one stripe period wide (50 × 50 of them on a map of any
 * size), bilinear between block centres.
 */
function groundLightness(image: RgbaImage, period: number): (x: number, y: number) => number {
  const block = Math.max(1, Math.min(Math.round(period), image.width, image.height))
  const small = boxDownscale(image, block)
  const { width, height, data } = small
  const lightness = new Float32Array(width * height)
  for (let i = 0; i < lightness.length; i++) {
    const o = i * 4
    lightness[i] = Math.cbrt(0.2126 * LINEAR[data[o]!]! + 0.7152 * LINEAR[data[o + 1]!]! + 0.0722 * LINEAR[data[o + 2]!]!)
  }
  const at = (x: number, y: number): number => lightness[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!
  return (x, y) => {
    const u = x / block - 0.5
    const v = y / block - 0.5
    const u0 = Math.floor(u)
    const v0 = Math.floor(v)
    const fu = u - u0
    const fv = v - v0
    const top = at(u0, v0) + (at(u0 + 1, v0) - at(u0, v0)) * fu
    const bottom = at(u0, v0 + 1) + (at(u0 + 1, v0 + 1) - at(u0, v0 + 1)) * fu
    return top + (bottom - top) * fv
  }
}

/** Signed distance (pixels, negative inside) from a pixel to a shape, both in output pixels. */
function signedDistance(shape: { kind: 'polygon'; points: [number, number][] } | { kind: 'circle'; x: number; y: number; r: number }, x: number, y: number): number {
  if (shape.kind === 'circle') return Math.hypot(x - shape.x, y - shape.y) - shape.r
  let inside = false
  let best = Infinity
  const pts = shape.points
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    const dx = xj - xi
    const dy = yj - yi
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)))
  }
  return inside ? -best : best
}

/**
 * The out-of-bounds hatch: the diagonal stripes of the game's ui/map_pattern_a
 * (16×16 texels), over the view minus the team's allowed battle areas, plus its
 * kill areas. A line covers `duty` of a period, in red set against the ground
 * under it (deeper over light ground, brighter over dark), so it reads on snow,
 * sand and forest alike and the ground between the lines stays as drawn. Line
 * and area edges are anti-aliased over one pixel.
 */
export function applyHatch(
  image: RgbaImage,
  areas: MapBattleAreas,
  toPixel: (x: number, z: number) => [number, number],
  metresToPixels: number,
  style: HatchStyle,
): void {
  interface Projected {
    shape: { kind: 'polygon'; points: [number, number][] } | { kind: 'circle'; x: number; y: number; r: number }
    x0: number
    y0: number
    x1: number
    y1: number
  }
  const project = (shape: GroundShape): Projected => {
    const projected = shape.kind === 'circle'
      ? { kind: 'circle' as const, ...(([x, y]) => ({ x, y }))(toPixel(shape.x, shape.z)), r: shape.r * metresToPixels }
      : { kind: 'polygon' as const, points: shape.points.map(([x, z]) => toPixel(x, z)) }
    const xs = projected.kind === 'circle' ? [projected.x - projected.r, projected.x + projected.r] : projected.points.map((p) => p[0])
    const ys = projected.kind === 'circle' ? [projected.y - projected.r, projected.y + projected.r] : projected.points.map((p) => p[1])
    // One pixel of margin for the anti-aliased edge.
    return { shape: projected, x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 }
  }
  const allowed = areas.allowed.map(project)
  const kill = areas.kill.map(project)
  if (allowed.length === 0 && kill.length === 0) return
  const { width, height, data } = image
  const ground = groundLightness(image, style.periodX)
  const [l0, l1] = style.lightness
  const coverage = (list: Projected[], x: number, y: number): number => {
    let best = 0
    for (const p of list) {
      if (x < p.x0 || x > p.x1) continue
      best = Math.max(best, Math.min(1, Math.max(0, 0.5 - signedDistance(p.shape, x, y))))
      if (best >= 1) break
    }
    return best
  }
  for (let py = 0; py < height; py++) {
    const y = py + 0.5
    const rowAllowed = allowed.filter((p) => y >= p.y0 && y <= p.y1)
    const rowKill = kill.filter((p) => y >= p.y0 && y <= p.y1)
    for (let px = 0; px < width; px++) {
      const x = px + 0.5
      // 1 outside every allowed area, 1 inside a kill area, a ramp over the edge pixel.
      const inAllowed = allowed.length === 0 ? 1 : coverage(rowAllowed, x, y)
      const out = Math.max(1 - inAllowed, rowKill.length === 0 ? 0 : coverage(rowKill, x, y))
      if (out <= 0) continue
      // Distance from the stripe centre line along x, in periods: on for |d| < duty / 2.
      const d = (((x - y - style.phase) / style.periodX) % 1 + 1.5) % 1 - 0.5
      const stripe = Math.min(1, Math.max(0, (style.duty / 2 - Math.abs(d)) * style.periodX * Math.SQRT1_2 + 0.5))
      const a = style.alpha * stripe * out
      if (a <= 0) continue
      const t = Math.min(1, Math.max(0, (ground(x, y) - l0) / (l1 - l0)))
      const o = (py * width + px) * 4
      for (let c = 0; c < 3; c++) {
        const line = style.onDark[c]! + (style.onLight[c]! - style.onDark[c]!) * t
        data[o + c] = Math.round(data[o + c]! * (1 - a) + line * a)
      }
    }
  }
}
