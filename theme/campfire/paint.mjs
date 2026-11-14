// Paints the camp of the "Campfire" background in pixel art and writes it as a PNG (no dependency).
//   node theme/campfire/paint.mjs
// Outputs: campfire.png (the atlas the shader reads) and preview.png (the camp enlarged on the background, to check it).
// Atlas: scenery at (0,0); its mask right below (red = lit by the fire, blue = ember);
// then the cat's 6 frames. Magenta = transparent. The sky, stars, mountains, forest, flames,
// sparks and smoke are drawn by the shader, not here.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))

// The camp: W x H pixels, the ground starts at row GY.
export const W = 200
export const H = 80
export const GY = 71
export const CAT = { l: 22, h: 20, y: 2 * H, n: 6 }
export const AW = W
export const AH = CAT.y + CAT.h
export const FIRE = { x: 78, y: GY - 2 }
export const CAT_POS = { x: 34, y: GY - 19 }
export const BACKGROUND = '#08080a'

const EMPTY = [255, 0, 255]
const img = new Uint8Array(AW * AH * 3)
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= AW || y >= AH) return

  img.set(c, (y * AW + x) * 3)
}
const get = (x, y) => {
  const i = (Math.max(0, Math.min(AH - 1, y)) * AW + Math.max(0, Math.min(AW - 1, x))) * 3

  return [img[i], img[i + 1], img[i + 2]]
}
// One scenery pixel, with its share of firelight (0 to 1) and of ember glow (0 to 1) in the mask.
const p = (x, y, c, light = 0, ember = 0) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return

  set(x, y, typeof c === 'string' ? hex(c) : c)
  set(x, y + H, [Math.round(light * 255), 0, Math.round(ember * 255)])
}
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
const dither = (x, y) => (BAYER[y & 3][x & 3] + 0.5) / 16
const hash = (x, y = 0) => {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0

  n = Math.imul(n ^ (n >>> 13), 1274126177)

  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
// A pattern in letters: '.' = nothing; tints = letter → colour; light = share lit by the fire.
const pattern = (x0, y0, rows, tints, light = 0.6, mirror = false) => {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const s = row[mirror ? row.length - 1 - c : c]

      if (s !== '.') p(x0 + c, y0 + r, tints[s], light)
    }
  })
}

for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) set(x, y, y >= H && y < 2 * H ? [0, 0, 0] : EMPTY)

// ── Firelight: dithered rings around the hearth ────────────────────────────────────────────────
const ground = () => GY
const band = (x, y) => {
  const l = 1 - Math.hypot(x - FIRE.x, (y - GY + 1) * 1.4) / 46

  return Math.max(0, Math.min(4, Math.floor(l * 4.6 + (dither(x, y) - 0.5) * 0.9)))
}
const GRASS_TOP = ['#1c2c30', '#2a4036', '#48583a', '#74703c', '#a08a44'].map(hex)
const GRASS = ['#141f26', '#1d2f2c', '#33402e', '#525030', '#746238'].map(hex)
const SOIL = ['#0d0e12', '#17171f', '#261f22', '#3a2c28', '#523a2c'].map(hex)

// ── The camp's fir trees: in tiers, the edge facing the fire catches its light ─────────────────
const fir = (x, h) => {
  const tier = Math.max(3, Math.round(h / 4.5))
  const halfMax = Math.max(2, Math.round(h * 0.3))
  const trunk = Math.max(2, Math.round(h / 10))
  const towardFire = x > FIRE.x ? -1 : 1
  const near = Math.abs(x - FIRE.x) < 75

  for (let r = 0; r <= trunk; r++) for (let dx = -1; dx <= (h > 40 ? 1 : 0); dx++) p(x + dx, GY - r, dx === towardFire * -1 || !near ? '#17131a' : '#3a2a22', 0.4)

  for (let r = 0; r < h; r++) {
    const inTier = r % tier
    const half = Math.round(Math.min(halfMax, Math.floor(r / tier) * (halfMax / (h / tier)) * 0.9 + inTier * 0.75 + (r < 2 ? 0 : 0.6)))
    const y = GY - trunk - h + r
    const tierBottom = inTier === tier - 1

    for (let dx = -half; dx <= half; dx++) {
      const edge = dx === towardFire * half && half > 0
      const warm = near && r > h * 0.3
      const inner = dx === towardFire * (half - 1) && half > 2 && tierBottom && warm

      if (edge) p(x + dx, y, warm ? '#5a4a2a' : '#1a2a2c', warm ? 0.7 : 0)
      else if (inner) p(x + dx, y, '#33321f', 0.6)
      else p(x + dx, y, tierBottom ? '#0a1114' : hash(x + dx, y) < 0.18 ? '#13211f' : '#0f1a1c')
    }
  }
}

fir(9, 34)
fir(126, 50)
fir(166, 58)
fir(184, 66)
fir(196, 46)

// ── The tent: canvas light on the fire side, dark on the other, a lamp inside ──────────────────
const TX = 142
const TH = 30
const TD = 22

for (let i = 0; i < 16; i++) {
  if (i % 2) continue
  p(TX - 14 - i, GY - 16 + i, '#3c3440')
  p(TX + 14 + i, GY - 16 + i, '#2a2630')
}
p(TX - 30, GY - 1, '#6a5a4a', 0.5)
p(TX + 30, GY - 1, '#3a3238')
for (let r = 0; r < TH; r++) {
  const y = GY - TH + r
  const half = Math.round(((r + 1) * TD) / TH)
  const door = Math.floor((r - 9) * 0.36)

  for (let dx = -half; dx <= half; dx++) {
    const edge = Math.abs(dx) === half
    let c
    let light = dx < 0 ? 0.8 : 0.25
    let ember = 0

    if (r >= 9 && Math.abs(dx) <= door) {
      const lamp = Math.hypot(dx, (GY - 4 - y) * 1.2)

      c = lamp < 1 ? '#ffd27a' : lamp < 2 ? '#b06a2c' : lamp < 3.6 ? '#4a2c20' : '#1c1418'
      ember = lamp < 3.6 ? 1 : 0
      light = 0
    } else if (r >= 9 && Math.abs(dx) === door + 1) c = dx < 0 ? '#ecb880' : '#8a6248'
    else if (dx < 0) c = edge ? '#e2a66a' : r > TH - 4 ? '#a06a44' : (dx + r) % 7 === 0 ? '#b0744a' : '#c4844f'
    else c = edge ? '#33262a' : r > TH - 4 ? '#4a3430' : '#6a4a3c'

    p(TX + dx, y, c, light, ember)
  }
}
p(TX, GY - TH - 1, '#8a6a4c', 0.6)
p(TX, GY - TH - 2, '#8a6a4c', 0.6)

// ── The ground: grass, then soil that frays away downwards ─────────────────────────────────────
for (let x = 0; x < W; x++) {
  for (let y = GY; y < H; y++) {
    const d = y - GY

    if (d > 2 && dither(x, y) < (d - 2) / 7) continue

    const b = band(x, y)
    const dark = d > 0 && d <= 2 && hash(x, y) < 0.28 ? Math.max(0, b - 1) : b

    p(x, y, d === 0 ? GRASS_TOP[b] : d <= 2 ? GRASS[dark] : SOIL[b], b / 4)
  }
}

// Grass blades, flowers, a mushroom, pebbles: the mound is not a flat fill.
for (let x = 2; x <= W - 3; x++) {
  if (Math.abs(x - FIRE.x) < 14 || (x > 93 && x < 117) || (x > TX - TD - 2 && x < TX + TD + 2)) continue

  const h = hash(x, 5)
  const y = ground(x)
  const c = GRASS_TOP[band(x, y)]
  const l = band(x, y) / 4

  if (h < 0.22) {
    p(x, y - 1, c, l)
    if (h < 0.11) p(x + (h < 0.055 ? 1 : -1), y - 2, c, l)
  } else if (h > 0.94) {
    p(x, y - 1, c, l)
    p(x, y - 2, c, l)
    p(x - 1, y - 3, c, l)
  }
}
for (const [x, head] of [[18, '#e9dcf2'], [29, '#f2b6c6'], [62, '#f4e6a8'], [172, '#e9dcf2']]) {
  p(x, ground(x) - 1, GRASS_TOP[band(x, ground(x))], 0.3)
  p(x, ground(x) - 2, GRASS_TOP[band(x, ground(x))], 0.3)
  p(x, ground(x) - 3, head, 0.3)
}
pattern(21, ground(20) - 3, ['.rRr.', 'rrwrr', '..t..'], { r: '#b8473c', R: '#d8675a', w: '#f0e4d0', t: '#d8ccb4' }, 0.2)
pattern(14, ground(11), ['.cc.', 'cCCd'], { c: '#4a4e5c', C: '#3a3e4a', d: '#262a36' }, 0.1)
pattern(59, ground(55), ['.cc', 'cCd'], { c: '#8a7c70', C: '#665a56', d: '#3c3438' }, 0.6)

// ── The hearth: ashes, back stones, crossed logs, embers, front stones ─────────────────────────
const FY = ground(FIRE.x)

for (let x = FIRE.x - 9; x <= FIRE.x + 9; x++) {
  p(x, FY, hash(x, 31) < 0.4 ? '#3a2a26' : '#2a2022', 0.9)
  p(x, FY + 1, '#221a1e', 0.8)
}

const STONE = { h: '#b8a082', m: '#806e64', d: '#463c44' }

pattern(FIRE.x - 9, FY - 3, ['.hh.', 'mmhd'], STONE, 0.9, true)
pattern(FIRE.x + 5, FY - 3, ['.hh.', 'hmmd'], STONE, 0.9)

const log = (x0, y0, x1, y1) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))

  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n)
    const y = Math.round(y0 + ((y1 - y0) * i) / n)
    const core = Math.abs(x - FIRE.x) <= 3

    p(x, y, core ? '#e8682a' : i === n ? '#8a6444' : '#5c3c2a', 1, core ? 1 : 0)
    p(x, y + 1, core ? '#8c3018' : '#2e1e1c', 0.8, core ? 0.6 : 0)
  }
}

log(FIRE.x - 8, FY - 1, FIRE.x + 7, FY - 7)
log(FIRE.x + 8, FY - 1, FIRE.x - 7, FY - 7)
for (let x = FIRE.x - 5; x <= FIRE.x + 5; x++) {
  const h = hash(x, 77)

  p(x, FY - 1, h < 0.35 ? '#ffc04a' : h < 0.7 ? '#ee6a22' : '#8a2a18', 1, 1)
  if (Math.abs(x - FIRE.x) < 4) p(x, FY, h < 0.5 ? '#c8421c' : '#6a2016', 1, 0.8)
}

const FRONT = ['.hhh.', 'hhmmd', 'mmmdd']

pattern(FIRE.x - 13, FY - 1, FRONT, STONE, 0.8, true)
pattern(FIRE.x - 8, FY + 1, FRONT, STONE, 0.85, true)
pattern(FIRE.x - 2, FY + 2, ['.hhh.', 'hhhhd', 'mmmdd'], STONE, 0.9)
pattern(FIRE.x + 4, FY + 1, FRONT, STONE, 0.85)
pattern(FIRE.x + 9, FY - 1, FRONT, STONE, 0.8)

// ── The log to sit on, the mug, the skewer leaning on it ───────────────────────────────────────
const RX = 96
const RY = GY - 6

for (let x = RX + 2; x <= RX + 17; x++) {
  for (let r = 0; r < 7; r++) {
    if ((x === RX + 17 && (r === 0 || r === 6)) || (x === RX + 16 && r === 6)) continue

    const grain = hash(x >> 1, r + 40) < 0.3
    const c = r === 0 ? (x < RX + 10 ? '#8a6444' : '#6e4e38') : r === 6 ? '#1e1618' : r === 5 ? '#2c1f1e' : grain ? '#3a2620' : '#4c3226'

    p(x, RY + r, c, r === 0 ? 0.8 : 0.45)
  }
}
pattern(RX, RY, ['.oo.', 'oiio', 'oico', 'oico', 'oiio', 'oiio', '.oo.'], { o: '#8c6a46', i: '#c69c68', c: '#a67c50' }, 0.95)
pattern(RX + 9, RY - 4, ['wwww.', 'lggwa', 'lggwa', 'lggg.'], { w: '#e6eaf0', l: '#f4dcae', g: '#aab2c0', a: '#7c8698' }, 0.7)
for (let i = 0; i <= 8; i++) p(RX + 1 - i, RY - 1 - Math.round(i * 0.8), '#7a583c', 0.8)
pattern(RX - 9, RY - 10, ['ww', 'wt'], { w: '#fff4e0', t: '#e2b074' }, 1)

// ── The cat (6 frames: sitting with tail low, mid, high; eyes closed; asleep, two breaths) ──────
const SITTING = [
  '...O.........O........',
  '..OBO.......OBO.......',
  '..OBBO.....OBBO.......',
  '..OBPBOOOOOBPBO.......',
  '..OBBBSBSBSBBBO.......',
  '.OBBBBBBBBBBBBBO......',
  '.OBBBBBBBBBBBBBO......',
  '.OBBEEBBBBBEEBBO......',
  '.OBBEKBBBBBEKBBO......',
  '.OBBBBBWNWBBBBBO......',
  '.OSBBBWWWWWBBBSO......',
  '..OBBBBWWWBBBBO.......',
  '..OBBBWWWWWBBBO.......',
  '.OBBBWWWWWWWBBBO......',
  '.OBBBWWWWWWWBBBO......',
  '.OSBBBWWWWWBBBSO......',
  '.OBBBBWWWWWBBBBO......',
  '.OBWWBBBBBBBWWBO......',
  '.OWWWOBBBBBOWWWO......',
  '..OOO.OOOOO.OOO.......',
]
const TAILS = [
  ['......', '......', '......', '......', '......', '......', '......', '.OOOO.', 'OBBBSO', 'OOOOO.'],
  ['......', '......', '......', '......', '...OO.', '..OSBO', '..OBO.', '.OBBO.', 'OBBO..', 'OOO...'],
  ['...OO.', '..OSBO', '..OBBO', '..OBO.', '..OBO.', '.OBBO.', '.OBO..', '.OBO..', 'OBBO..', 'OOO...'],
]
const ASLEEP = [
  '......................',
  '......................',
  '......................',
  '......................',
  '......................',
  '......................',
  '......................',
  '......................',
  '...O.......O..........',
  '..OBO.....OBO.........',
  '..OBPOOOOOPBOOOOOO....',
  '..OBBSBSBSBBBBBBBBOO..',
  '.OBBBBBBBBBBBSBBSBBBO.',
  '.OBOOBBBBOOBBBBBBBBBO.',
  '.OBBBBWNWBBBBSBBSBBBBO',
  '.OBBBWWWWWBBBBBBBBBBBO',
  '.OBBBBWWWBBBBBBBBBBBSO',
  '.OWWWBBBBBBBBBBBBSSBBO',
  '..OWWOBBBBBBBBBOSBBBO.',
  '...OOOOOOOOOOOOOOOOO..',
]
const CAT_TINTS = { O: '#141018', B: '#c88450', S: '#935834', W: '#eadcc6', P: '#d98a8a', E: '#c8f27a', K: '#1a2a12', N: '#e08a8a' }
// The side facing the fire (on the right) catches its light.
const CAT_TINTS_FIRE = { ...CAT_TINTS, B: '#eaa864', S: '#b8703e', W: '#fff0d6' }
const catFrame = (n, rows, split) => {
  for (let r = 0; r < CAT.h; r++) {
    for (let c = 0; c < CAT.l; c++) {
      const s = (rows[r] ?? '')[c] ?? '.'

      set(n * CAT.l + c, CAT.y + r, s === '.' ? EMPTY : hex((c >= split ? CAT_TINTS_FIRE : CAT_TINTS)[s]))
    }
  }
}
const withTail = q => SITTING.map((row, r) => (r < 10 ? row : row.slice(0, 16) + TAILS[q][r - 10]))
const eyesClosed = rows => rows.map((row, r) => (r === 7 ? row.replaceAll('E', 'B') : r === 8 ? row.replaceAll('EK', 'OO') : row))

catFrame(0, withTail(0), 12)
catFrame(1, withTail(1), 12)
catFrame(2, withTail(2), 12)
catFrame(3, eyesClosed(withTail(0)), 12)
catFrame(4, ASLEEP, 15)
catFrame(5, ASLEEP.map((row, r) => (r === 10 ? '..OBPOOOOOPBOOOOOOO...' : row)), 15)

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────
const png = (width, height, rgb) => {
  const rows = Buffer.alloc((width * 3 + 1) * height)

  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(rows, y * (width * 3 + 1) + 1)

  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const b = Buffer.alloc(8 + body.length)

    b.writeUInt32BE(data.length, 0)
    body.copy(b, 4)
    b.writeUInt32BE(crc32(body) >>> 0, 4 + body.length)

    return b
  }
  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
// The preview: the camp and the sitting cat on the background colour, enlarged k times (without the flames).
const preview = k => {
  const bg = hex(BACKGROUND)
  const out = new Uint8Array(W * k * H * k * 3)

  for (let y = 0; y < H * k; y++) {
    for (let x = 0; x < W * k; x++) {
      const sx = Math.floor(x / k)
      const sy = Math.floor(y / k)
      let c = get(sx, sy)
      const cx = sx - CAT_POS.x
      const cy = sy - CAT_POS.y

      if (cx >= 0 && cx < CAT.l && cy >= 0 && cy < CAT.h) {
        const cat = get(cx, CAT.y + cy)

        if (cat[0] !== 255 || cat[1] !== 0) c = cat
      }

      out.set(c[0] === 255 && c[1] === 0 && c[2] === 255 ? bg : c, (y * W * k + x) * 3)
    }
  }

  return png(W * k, H * k, out)
}

writeFileSync(join(here, 'campfire.png'), png(AW, AH, img))
writeFileSync(join(here, 'preview.png'), preview(5))
console.log(`campfire.png ${AW}x${AH}`)
