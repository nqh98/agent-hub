import type { AgentInfo } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  applyList,
  applyTurnComplete,
  isPersonOrigin,
  applyTurnStart,
  elapsedMs,
  formatElapsed,
  latestTask,
  MAX_AGENTS,
  visibleTree,
} from './roster'
import type { Rows } from './roster'

const info = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  type: 'Explore',
  description: `task ${id}`,
  status: 'running',
  ...extra,
})

describe('roster', () => {
  test('a listed agent runs from the moment it is first seen', () => {
    const rows = applyList({}, [info('a')], 1000)

    expect(rows.a?.status).toBe('running')
    expect(rows.a?.isListed).toBe(true)
    expect(rows.a?.startedAt).toBe(1000)
    expect(elapsedMs(rows.a!, 43_000)).toBe(42_000)
  })

  test('turn.start before the list keeps its earlier start time', () => {
    const started = applyTurnStart({}, 'a', 500)
    const rows = applyList(started, [info('a')], 2000)

    expect(rows.a?.startedAt).toBe(500)
    expect(rows.a?.type).toBe('Explore')
  })

  test('turn.complete ends the agent and freezes its time', () => {
    let rows = applyList({}, [info('a')], 0)
    rows = applyTurnComplete(rows, 'a', 'answer', 9000)

    expect(rows.a?.status).toBe('completed')
    expect(elapsedMs(rows.a!, 60_000)).toBe(9000)
  })

  test('a stale snapshot right after the end does not revive the agent', () => {
    let rows = applyList({}, [info('a')], 0)
    rows = applyTurnComplete(rows, 'a', 'error', 9000)
    rows = applyList(rows, [info('a', { status: 'running' })], 10_000)

    expect(rows.a?.status).toBe('failed')
  })

  test('an agent gone from the list has ended', () => {
    let rows = applyList({}, [info('a')], 0)
    rows = applyList(rows, [], 4000)

    expect(rows.a?.status).toBe('completed')
    expect(rows.a?.endedAt).toBe(4000)
  })

  test('an interrupted agent reads as stopped', () => {
    const rows = applyTurnComplete(applyList({}, [info('a')], 0), 'a', 'aborted', 10)

    expect(rows.a?.status).toBe('killed')
  })

  test('a teammate goes idle at the end of a turn', () => {
    let rows = applyList({}, [info('t', { teammateId: 'scout@team', type: 'teammate' })], 0)
    rows = applyTurnComplete(rows, 't', 'answer', 100)

    expect(rows.t?.status).toBe('idle')
  })

  test('loops the list never names stay hidden', () => {
    const rows = applyTurnStart({}, 'fork-1', 0)

    expect(visibleTree(rows)).toEqual([])
  })

  test('children sit under their parent, busy roots first', () => {
    let rows: Rows = applyList(
      {},
      [info('old', { status: 'completed' }), info('p'), info('c', { parentId: 'p' })],
      0,
    )
    rows = applyList(rows, [info('old', { status: 'completed' }), info('p'), info('c', { parentId: 'p' })], 1)

    expect(visibleTree(rows).map(line => `${line.depth}:${line.row.id}`)).toEqual(['0:p', '1:c', '0:old'])
  })

  test('the oldest finished agents go first past the cap', () => {
    let rows: Rows = {}
    for (let i = 0; i < MAX_AGENTS + 5; i += 1) {
      rows = applyList(rows, [info(`a${i}`)], i)
      rows = applyTurnComplete(rows, `a${i}`, 'answer', i)
    }

    expect(Object.keys(rows)).toHaveLength(MAX_AGENTS)
    expect(rows.a0).toBeUndefined()
    expect(rows[`a${MAX_AGENTS + 4}`]).toBeDefined()
  })

  test('only the current prompt’s agents show, and whatever still runs', () => {
    let rows = applyList({}, [info('old-done', { status: 'completed' }), info('old-busy')], 0, 1)
    rows = applyList(rows, [info('old-done', { status: 'completed' }), info('old-busy'), info('new')], 1, 2)

    expect(Object.keys(latestTask(rows, 2)).sort()).toEqual(['new', 'old-busy'])

    // A later prompt that starts no agent shows only what still runs.
    expect(Object.keys(latestTask(rows, 3)).sort()).toEqual(['new', 'old-busy'])
    rows = applyTurnComplete(applyTurnComplete(rows, 'new', 'answer', 2), 'old-busy', 'answer', 2)
    expect(Object.keys(latestTask(rows, 3))).toEqual([])
  })

  test('rows from before tasks were kept count as the first prompt', () => {
    const old = { a: { ...applyList({}, [info('a', { status: 'completed' })], 0).a!, task: undefined } }

    expect(Object.keys(latestTask(old, 0))).toEqual(['a'])
    expect(Object.keys(latestTask(old, 4))).toEqual([])
  })

  test('elapsed time reads as m:ss, h:mm:ss past the hour', () => {
    expect(formatElapsed(42_000)).toBe('0:42')
    expect(formatElapsed(125_000)).toBe('2:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })

  test("only the person's prompts start a task: a notification or another session's message does not", () => {
    expect(isPersonOrigin({ kind: 'composer' })).toBe(true)
    expect(isPersonOrigin({ kind: 'bridge' })).toBe(true)
    expect(isPersonOrigin({ kind: 'plugin', name: 'agent-hub', asUser: true })).toBe(true)
    expect(isPersonOrigin({ kind: 'unclassified' })).toBe(true)
    expect(isPersonOrigin(undefined)).toBe(true)
    expect(isPersonOrigin({ kind: 'task-notification' })).toBe(false)
    expect(isPersonOrigin({ kind: 'peer' })).toBe(false)
    expect(isPersonOrigin({ kind: 'peer-send-message' })).toBe(false)
    expect(isPersonOrigin({ kind: 'observer' })).toBe(false)
    expect(isPersonOrigin({ kind: 'auto-continuation' })).toBe(false)
    expect(isPersonOrigin({ kind: 'plugin', name: 'other' })).toBe(false)
  })
})
