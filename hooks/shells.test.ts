import { describe, expect, test } from 'claude-code/testing'

import type { ShellRow } from '../types'
import {
  claimFiles,
  clip,
  commandLine,
  commandLines,
  endStatus,
  finalOutput,
  isStoppable,
  KEEP_LINES,
  MAX_SHELLS,
  readLog,
  shellFiles,
  shellHistory,
  startShell,
  toBackground,
  visibleShells,
} from './shells'

const shell = (id: string, extra: Partial<ShellRow> = {}): ShellRow => ({
  id,
  command: `echo ${id}`,
  task: 1,
  status: 'running',
  isBackground: false,
  startedAt: 1000,
  tail: [],
  ...extra,
})

describe('shells', () => {
  test('a log reads as its latest lines, colours, progress frames and secrets gone', () => {
    const log = readLog('one\n\x1b[32mtwo\x1b[0m\n10%\r50%\r100%\nkey token=abc123\n\n')

    expect(log.tail).toEqual(['one', 'two', '100%', 'key token=***'])
    expect(log.exitCode).toBeUndefined()
    expect(readLog('a\nb\nc', 2).tail).toEqual(['b', 'c'])
  })

  test("a background log's trailer is its exit code, not a line", () => {
    expect(readLog('built\n\n[exited with code 0]\n')).toEqual({ tail: ['built'], exitCode: 0 })
    expect(readLog('\n[exited with code 2]\n')).toEqual({ tail: [], exitCode: 2 })
  })

  test("a foreground call's output is its stdout and stderr, or the error text", () => {
    expect(finalOutput({ stdout: 'ok\n', stderr: 'warn' }, 'ok')).toEqual({ output: 'ok\n\nwarn', exitCode: undefined })
    expect(finalOutput(undefined, 'Exit code 1\nnpm ERR! missing script')).toEqual({
      output: 'npm ERR! missing script',
      exitCode: 1,
    })
    expect(endStatus({ result: { interrupted: true } })).toBe('stopped')
    expect(endStatus({ isError: true })).toBe('failed')
    expect(endStatus({ result: {} })).toBe('done')
  })

  test('new logs go to the waiting foreground shells in the order both began', () => {
    const shells = [shell('s1'), shell('s2', { isBackground: true }), shell('s3', { startedAt: 2000 })]
    const files = shellFiles([
      { name: 'bold.output', kind: 'file', mtimeMs: 1 },
      { name: 'a1.output', kind: 'other', mtimeMs: 2 },
      { name: 'bnew1.output', kind: 'file', mtimeMs: 5 },
      { name: 'bnew2.output', kind: 'file', mtimeMs: 6 },
    ])
    expect(files).toEqual(['bold', 'bnew1', 'bnew2'])

    const claimed = claimFiles(shells, files, new Set(['bold']))
    expect(claimed.shells.map(one => one.taskId)).toEqual(['bnew1', undefined, 'bnew2'])
    expect([...claimed.seen].sort()).toEqual(['bnew1', 'bnew2', 'bold'])
    expect(shellFiles([{ name: 'bx.output', kind: 'file', mtimeMs: 9 }], 9)).toEqual([])
  })

  test('a command moved to the background takes its own id back from a guess', () => {
    const shells = toBackground([shell('s1'), shell('s2', { taskId: 'bq', tail: ['x'] })], 's1', 'bq')

    expect(shells[0]).toMatchObject({ isBackground: true, taskId: 'bq' })
    expect(shells[1]).toMatchObject({ taskId: undefined, tail: [] })
  })

  test("each lane shows its latest command: the main one's stays, others while they run or are this task's", () => {
    const shells = [
      shell('m1', { status: 'done', startedAt: 1 }),
      shell('m2', { status: 'done', startedAt: 2 }),
      shell('x1', { agentId: 'a1', status: 'done', startedAt: 3 }),
      shell('y1', { agentId: 'a2', startedAt: 4, task: 0 }),
      shell('b1', { isBackground: true, status: 'failed', startedAt: 5, task: 0 }),
    ]

    expect(visibleShells(shells, 1).map(one => one.id)).toEqual(['m2', 'x1', 'y1'])
    expect(visibleShells(shells, 2).map(one => one.id)).toEqual(['m2', 'y1'])
  })

  test('the list keeps its running shells past the cap', () => {
    let shells: ShellRow[] = [shell('live', { startedAt: 0 })]
    for (let i = 0; i < MAX_SHELLS + 5; i += 1) shells = startShell(shells, shell(`d${i}`, { status: 'done' }))

    expect(shells).toHaveLength(MAX_SHELLS)
    expect(shells[0]?.id).toBe('live')
  })

  test('a command shows as its first line, cut to the row', () => {
    expect(commandLine('cd app &&\n  npm test')).toBe('cd app && …')
    expect(clip('npm run build', 8)).toBe('npm run…')
    expect(clip('ls', 8)).toBe('ls')
  })

  test('a log keeps its latest KEEP_LINES lines for the detail', () => {
    const text = Array.from({ length: KEEP_LINES + 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const { tail } = readLog(text)

    expect(tail).toHaveLength(KEEP_LINES)
    expect(tail[0]).toBe('line 11')
    expect(tail.at(-1)).toBe(`line ${KEEP_LINES + 10}`)
  })

  test('the detail shows every line of a command, secrets masked', () => {
    expect(commandLines('cd app &&\n\n  deploy --token=abc123 now   \n')).toEqual(['cd app &&', '  deploy --token=*** now'])
  })

  test('only a background command still running, with its id, can be stopped', () => {
    expect(isStoppable(shell('a', { isBackground: true, taskId: 'b1' }))).toBe(true)
    expect(isStoppable(shell('b', { isBackground: true }))).toBe(false)
    expect(isStoppable(shell('c', { taskId: 'b2' }))).toBe(false)
    expect(isStoppable(shell('d', { isBackground: true, taskId: 'b3', status: 'done' }))).toBe(false)
  })

  test('every shell is listed newest first', () => {
    const order = shellHistory([shell('old', { startedAt: 1 }), shell('new', { startedAt: 3 }), shell('mid', { startedAt: 2 })])

    expect(order.map(one => one.id)).toEqual(['new', 'mid', 'old'])
  })
})
