import { describe, expect, test } from 'claude-code/testing'

import { qrEncode, qrLines } from './qr'

const picture = (rows: boolean[][]): string[] => rows.map(row => row.map(dark => (dark ? '#' : '.')).join(''))

// Drawn by Project Nayuki's qrcodegen (as qrcode.react vendors it) for the same text at level L.
const AGENT_HUB = [
    '#######.#####.#######',
    '#.....#.###...#.....#',
    '#.###.#.##.##.#.###.#',
    '#.###.#.#...#.#.###.#',
    '#.###.#.#.##..#.###.#',
    '#.....#..##...#.....#',
    '#######.#.#.#.#######',
    '........##...........',
    '.##.#.##..#...#.#####',
    '#.#.#..#.####...#..##',
    '#..#.##.####.#####.##',
    '..#.##...#.##..#.....',
    '#.##..#.#####.......#',
    '........#.##.#.##..##',
    '#######.##.#...######',
    '#.....#..##.##.#.....',
    '#.###.#.#..#..#.#....',
    '#.###.#..#....###.##.',
    '#.###.#.#...#...#...#',
    '#.....#.###...##...#.',
    '#######..#..#.####.##',
]
const SHARE_LINK = [
    '#######.#.#.....#########.#######',
    '#.....#.#...#.#.##..#..#..#.....#',
    '#.###.#..#..###.#.##...##.#.###.#',
    '#.###.#.#..........#.##.#.#.###.#',
    '#.###.#.....#...##.#....#.#.###.#',
    '#.....#..#.#..###..#..#...#.....#',
    '#######.#.#.#.#.#.#.#.#.#.#######',
    '........##....#####.#.##.........',
    '#.##.###......####..##..#.#..#.##',
    '.#####....##.#..####.#.##.##.####',
    '....#.##.....#......##.#######.##',
    '#.####.##..#........#.#.####.#..#',
    '#######..##...#..#....#..#..##.##',
    '..#.##...###..#..........###...#.',
    '####.##.##....#..######...##.....',
    '..#.##..######..#.##########..#..',
    '#....###....#..#..#..#.#..#.#.#..',
    '..#..#....#..#.#.#.....##.#.##..#',
    '..##.#####...###.##.#....####.#..',
    '..#.#..#.###.#.####...#..#..#..#.',
    '...#..###..#.####.##....##.#.##.#',
    '#####..##..####.######.#.###.#..#',
    '..##..####.####..##.##.#..##...##',
    '.##.##...##....#....#.#.##..##..#',
    '#.#..##....##....#....#########.#',
    '........#....#.#...#...##...##...',
    '#######.###.###.#.###..##.#.#..#.',
    '#.....#.##..##....##.#.##...####.',
    '#.###.#....#..#...#.#########.###',
    '#.###.#.#.###.#..#.##.#..#.#..#.#',
    '#.###.#.#.#.#####.#.#..#####..#..',
    '#.....#.......#.##.....#...##...#',
    '#######.###..#.#.###.#.#....###..',
]

describe('qr', () => {
  test('a short text is a version 1 code, module for module as the reference draws it', () => {
    const code = qrEncode('agent hub')!

    expect(code.version).toBe(1)
    expect(code.size).toBe(21)
    expect(picture(code.rows)).toEqual(AGENT_HUB)
  })

  test("the remote's share link is a version 4 code, alignment pattern and all", () => {
    const code = qrEncode('https://04ce61c2bce68a.lhr.life/?t=Xq3v_9Lr0aBcDeFgHiJkLmNo')!

    expect(code.version).toBe(4)
    expect(picture(code.rows)).toEqual(SHARE_LINK)
  })

  test('a text longer than version 40 holds has no code', () => {
    expect(qrEncode('x'.repeat(3000))).toBeUndefined()
  })

  test('the lines pack two module rows a cell, light drawn, inside a light margin', () => {
    const code = { version: 1, size: 2, rows: [[true, false], [false, true]] }

    expect(qrLines(code, 1)).toEqual(['█▀██', '██▄█'])
    expect(qrLines(code, 2)).toEqual(['██████', '██▄▀██', '██████'])
  })

  test('an odd count of module rows leaves the last cell half dark below', () => {
    expect(qrLines({ version: 1, size: 1, rows: [[true]] }, 1)).toEqual(['█▀█', '▀▀▀'])
  })

  test("a share link's lines are as wide as the code and its margin, half as tall", () => {
    const lines = qrLines(qrEncode('https://04ce61c2bce68a.lhr.life/?t=Xq3v_9Lr0aBcDeFgHiJkLmNo')!)

    expect(lines).toHaveLength(19)
    for (const line of lines) expect([...line]).toHaveLength(37)
  })
})
