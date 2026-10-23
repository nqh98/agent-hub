// A QR code for the remote's link, so a phone opens it by its camera. Byte
// mode only (a link is bytes), after Project Nayuki's qrcodegen (MIT): the
// smallest version that holds the text at error correction level L, the level
// raised as far as that version still holds it, and the mask scored lowest.

/** The code's modules, `true` dark, `rows[y][x]`; `version` 1 to 40. */
export type QrCode = { version: number; size: number; rows: boolean[][] }

type Ecc = 0 | 1 | 2 | 3 // L, M, Q, H

// Per level, indexed by version (0 unused): the error correction codewords
// in each block, and the number of blocks.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]
// How each level is written in the format bits.
const FORMAT_BITS = [1, 0, 3, 2]

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

function utf8(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }

  return out
}

// The modules left for data and error correction, after the function patterns.
function rawModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (ver >= 7) result -= 36
  }

  return result
}

const dataCodewords = (ver: number, ecc: Ecc): number => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc]![ver]! * BLOCKS[ecc]![ver]!

// Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }

  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }

  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => (result[i]! ^= gfMul(coef, factor)))
  }

  return result
}

// The data split into blocks, each given its error correction, then interleaved.
function withEcc(data: readonly number[], ver: number, ecc: Ecc): number[] {
  const count = BLOCKS[ecc]![ver]!
  const eccLen = ECC_PER_BLOCK[ecc]![ver]!
  const raw = Math.floor(rawModules(ver) / 8)
  const shortCount = count - (raw % count)
  const shortLen = Math.floor(raw / count)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < count; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortCount ? 0 : 1))
    k += dat.length
    const tail = rsRemainder(dat, divisor)
    if (i < shortCount) dat.push(0)
    blocks.push([...dat, ...tail])
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortCount) result.push(block[i]!)
    })
  }

  return result
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos)

  return result
}

class Grid {
  readonly rows: boolean[][]
  readonly fixed: boolean[][]
  constructor(readonly size: number) {
    this.rows = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  set(x: number, y: number, dark: boolean) {
    this.rows[y]![x] = dark
    this.fixed[y]![x] = true
  }

  format(ecc: Ecc, mask: number) {
    const data = (FORMAT_BITS[ecc]! << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const size = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i))
    this.set(8, size - 8, true)
  }

  mask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.fixed[y]![x]) continue
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]
        if (flip) this.rows[y]![x] = !this.rows[y]![x]
      }
    }
  }

  // The penalty the mask choice minimises: runs, 2x2 blocks, finder-like
  // patterns and the dark/light balance.
  penalty(): number {
    const size = this.size
    let result = 0
    const addHistory = (run: number, history: number[]) => {
      if (history[0] === 0) run += size
      history.pop()
      history.unshift(run)
    }
    const countPatterns = (h: number[]): number => {
      const n = h[1]!
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n

      return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
    }
    const line = (at: (i: number) => boolean) => {
      let color = false
      let run = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let i = 0; i < size; i++) {
        if (at(i) === color) {
          run++
          if (run === 5) result += 3
          else if (run > 5) result++
        } else {
          addHistory(run, history)
          if (!color) result += countPatterns(history) * 40
          color = at(i)
          run = 1
        }
      }
      if (color) {
        addHistory(run, history)
        run = 0
      }
      addHistory(run + size, history)
      result += countPatterns(history) * 40
    }
    for (let y = 0; y < size; y++) line(x => this.rows[y]![x]!)
    for (let x = 0; x < size; x++) line(y => this.rows[y]![x]!)
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.rows[y]![x]
        if (c === this.rows[y]![x + 1] && c === this.rows[y + 1]![x] && c === this.rows[y + 1]![x + 1]) result += 3
      }
    }
    const dark = this.rows.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const total = size * size

    return result + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  }
}

function draw(ver: number, ecc: Ecc, codewords: readonly number[]): Grid {
  const size = ver * 4 + 17
  const grid = new Grid(size)
  for (let i = 0; i < size; i++) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) grid.set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  const align = alignmentPositions(ver, size)
  const n = align.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) grid.set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  grid.format(ecc, 0)
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      grid.set(a, b, bit(bits, i))
      grid.set(b, a, bit(bits, i))
    }
  }
  // The codewords in the zigzag, two columns at a time from the right, skipping the timing column.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!grid.fixed[y]![x] && i < codewords.length * 8) {
          grid.rows[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7))
          i++
        }
      }
    }
  }

  return grid
}

/** The QR code of a text; undefined when it is longer than version 40 holds. */
export function qrEncode(text: string): QrCode | undefined {
  const bytes = utf8(text)
  const used = (ver: number) => 4 + (ver < 10 ? 8 : 16) + bytes.length * 8
  let ver = 1
  while (used(ver) > dataCodewords(ver, 0) * 8) if (++ver > 40) return undefined
  let ecc: Ecc = 0
  for (const higher of [1, 2, 3] as const) if (used(ver) <= dataCodewords(ver, higher) * 8) ecc = higher

  const capacity = dataCodewords(ver, ecc) * 8
  const bits: number[] = []
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(0b0100, 4)
  append(bytes.length, ver < 10 ? 8 : 16)
  for (const b of bytes) append(b, 8)
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const data = new Array<number>(bits.length / 8).fill(0)
  bits.forEach((b, i) => (data[i >>> 3]! |= b << (7 - (i & 7))))

  const grid = draw(ver, ecc, withEcc(data, ver, ecc))
  let best = 0
  let lowest = Infinity
  for (let mask = 0; mask < 8; mask++) {
    grid.mask(mask)
    grid.format(ecc, mask)
    const score = grid.penalty()
    if (score < lowest) {
      best = mask
      lowest = score
    }
    grid.mask(mask)
  }
  grid.mask(best)
  grid.format(ecc, best)

  return { version: ver, size: grid.size, rows: grid.rows }
}

/**
 * The code as terminal lines, two modules to a cell with half blocks, light
 * drawn and dark left blank, inside a light margin of `quiet` modules. Drawn
 * light on dark (the caller sets both colours), so any theme scans the same.
 */
export function qrLines(code: QrCode, quiet = 2): string[] {
  const span = code.size + quiet * 2
  const light = (x: number, y: number): boolean => {
    if (y >= span) return false
    const cx = x - quiet
    const cy = y - quiet

    return cx < 0 || cy < 0 || cx >= code.size || cy >= code.size || !code.rows[cy]![cx]
  }
  const lines: string[] = []
  for (let y = 0; y < span; y += 2) {
    let line = ''
    for (let x = 0; x < span; x++) {
      const top = light(x, y)
      const bottom = light(x, y + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }

  return lines
}
