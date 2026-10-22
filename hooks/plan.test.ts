import { describe, expect, test } from 'claude-code/testing'

import { applyPlan, applyStepUsage, cacheParts, cacheReading, currentTaskAfter, nextPlan, planFromTaskList, stampStarts, applyUsage, formatTokens, limitParts, formatUsd, planProgress, settleLive, totalTokens, usageOf } from './plan'
import { applyTurnBegin, applyTurnEnd } from './steps'

const usage = (input: number, output: number, model = 'claude-sonnet-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
  model,
})

describe('plan', () => {
  test('TodoWrite replaces the whole plan', () => {
    let acts = applyPlan({}, 'a', 'TodoWrite', { todos: [{ content: 'Find routes', status: 'completed' }] }, {})
    acts = applyPlan(
      acts,
      'a',
      'TodoWrite',
      {
        todos: [
          { content: 'Find routes', status: 'completed' },
          { content: 'Read callers', status: 'in_progress' },
          { content: 'Summarize', status: 'pending' },
        ],
      },
      {},
    )

    expect(acts.a?.todos?.map(item => `${item.status}:${item.text}`)).toEqual([
      'completed:Find routes',
      'in_progress:Read callers',
      'pending:Summarize',
    ])
    expect(planProgress(acts.a!.todos!)).toBe('☑ 1/3')
  })

  test('TaskCreate adds the task its result names; TaskUpdate moves and deletes it', () => {
    let acts = applyPlan({}, 'a', 'TaskCreate', { subject: 'Run tests', description: '' }, { task: { id: '7', subject: 'Run tests' } })
    acts = applyPlan(acts, 'a', 'TaskCreate', { subject: 'Fix', description: '' }, { task: { id: '8', subject: 'Fix' } })
    acts = applyPlan(acts, 'a', 'TaskUpdate', { taskId: '7', status: 'in_progress' }, { success: true, taskId: '7' })

    expect(acts.a?.todos).toEqual([
      { id: '7', text: 'Run tests', status: 'in_progress' },
      { id: '8', text: 'Fix', status: 'pending' },
    ])

    acts = applyPlan(acts, 'a', 'TaskUpdate', { taskId: '8', status: 'deleted' }, { success: true, taskId: '8' })
    expect(acts.a?.todos?.map(item => item.id)).toEqual(['7'])
  })

  test('a failed update, an unknown task or a malformed call changes nothing', () => {
    const acts = applyPlan({}, 'a', 'TaskCreate', { subject: 'X' }, { task: { id: '1', subject: 'X' } })

    expect(applyPlan(acts, 'a', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: false })).toBe(acts)
    expect(applyPlan(acts, 'a', 'TaskUpdate', { taskId: '99', status: 'completed' }, { success: true })).toBe(acts)
    expect(applyPlan(acts, 'a', 'TaskCreate', { subject: 'Y' }, {})).toBe(acts)
    expect(applyPlan(acts, 'a', 'Read', { file_path: 'x' }, {})).toBe(acts)
  })

  test('plan text is cut and masked', () => {
    const acts = applyPlan({}, 'a', 'TodoWrite', { todos: [{ content: `export API_KEY=abc ${'y'.repeat(200)}`, status: 'pending' }] }, {})

    expect(acts.a?.todos?.[0]?.text.startsWith('export API_KEY=*** ')).toBe(true)
    expect(acts.a?.todos?.[0]?.text).toHaveLength(120)
  })
})

describe('main checklist', () => {
  test('the in-progress wording is kept from each kind of call', () => {
    let list = nextPlan([], 'TaskCreate', { subject: 'Run tests', description: '', activeForm: 'Running tests' }, { task: { id: '1', subject: 'Run tests' } })
    list = nextPlan(list!, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true })
    expect(list).toEqual([{ id: '1', text: 'Run tests', status: 'in_progress', active: 'Running tests' }])

    const written = nextPlan([], 'TodoWrite', { todos: [{ content: 'Read code', status: 'in_progress', activeForm: 'Reading code' }] }, {})
    expect(written?.[0]).toMatchObject({ text: 'Read code', active: 'Reading code' })
  })

  test('the current task is the one just started, kept while it runs, cleared when none runs', () => {
    const item = (id: string, status: 'pending' | 'in_progress' | 'completed') => ({ id, text: id, status })

    expect(currentTaskAfter([item('1', 'pending')], [item('1', 'in_progress')], null)).toBe('1')
    expect(currentTaskAfter([item('1', 'in_progress'), item('2', 'pending')], [item('1', 'in_progress'), item('2', 'in_progress')], '1')).toBe('2')
    expect(currentTaskAfter([item('1', 'in_progress')], [item('1', 'in_progress'), item('2', 'pending')], '1')).toBe('1')
    expect(currentTaskAfter([item('1', 'in_progress')], [item('1', 'completed')], '1')).toBeNull()
    expect(currentTaskAfter([item('1', 'in_progress'), item('2', 'in_progress')], [item('1', 'completed'), item('2', 'in_progress')], '1')).toBe('2')
  })

  test('a task put in progress is stamped once, and keeps its stamp while it runs', () => {
    const item = (id: string, status: 'pending' | 'in_progress' | 'completed', startedAt?: number) => ({ id, text: id, status, ...(startedAt === undefined ? {} : { startedAt }) })

    expect(stampStarts([item('1', 'pending')], [item('1', 'in_progress')], 500)).toEqual([item('1', 'in_progress', 500)])
    expect(stampStarts([item('1', 'in_progress', 500)], [item('1', 'in_progress')], 900)).toEqual([item('1', 'in_progress', 500)])
    expect(stampStarts([item('1', 'in_progress', 500)], [item('1', 'completed')], 900)).toEqual([item('1', 'completed')])
  })

  test('TaskList seeds the checklist; any other shape is ignored', () => {
    expect(
      planFromTaskList({
        tasks: [
          { id: '1', subject: 'Plan', status: 'completed', blockedBy: [] },
          { id: '2', subject: 'Build', status: 'in_progress', blockedBy: [] },
        ],
      }),
    ).toEqual([
      { id: '1', text: 'Plan', status: 'completed' },
      { id: '2', text: 'Build', status: 'in_progress' },
    ])
    expect(planFromTaskList(undefined)).toBeUndefined()
    expect(planFromTaskList({ tasks: 'none' })).toBeUndefined()
  })
})

describe('tokens', () => {
  test('each turn adds to the total, the latest model wins', () => {
    let acts = applyUsage({}, 'a', usage(500, 100, 'claude-haiku-5-5'))
    acts = applyUsage(acts, 'a', usage(300, 50))

    expect(acts.a?.usage).toEqual({ input: 800, output: 150, cacheRead: 2000, cacheWrite: 400, model: 'claude-sonnet-5-5' })
    expect(totalTokens(acts.a!.usage!)).toBe(3350)
  })

  test('a turn ending keeps the plan and the tokens', () => {
    let acts = applyTurnBegin({}, 'a', 't1', 'go', 0)
    acts = applyPlan(acts, 'a', 'TodoWrite', { todos: [{ content: 'One', status: 'pending' }] }, {})
    acts = applyUsage(acts, 'a', usage(10, 5))
    acts = applyTurnEnd(acts, 'a', 't1', 'answer', 9)

    expect(acts.a?.todos).toHaveLength(1)
    expect(acts.a?.usage?.output).toBe(5)
    expect(acts.a?.turnId).toBeUndefined()
  })

  test('steps count live, and the turn total takes their place', () => {
    let acts = applyUsage({}, 'a', usage(100, 10))
    acts = applyStepUsage(acts, 'a', usage(500, 50))
    acts = applyStepUsage(acts, 'a', usage(600, 60))
    expect(usageOf(acts.a)).toMatchObject({ input: 1200, output: 120, cacheRead: 3000 })

    acts = applyUsage(acts, 'a', usage(1100, 110))
    expect(acts.a?.live).toBeUndefined()
    expect(usageOf(acts.a)).toMatchObject({ input: 1200, output: 120, cacheRead: 2000 })
  })

  test('a turn that ends with no usage keeps what its steps counted', () => {
    let acts = applyStepUsage({}, 'a', usage(500, 50))
    acts = settleLive(acts, 'a')

    expect(acts.a?.live).toBeUndefined()
    expect(acts.a?.usage).toMatchObject({ input: 500, output: 50 })
    expect(settleLive(acts, 'a')).toBe(acts)
  })

  test('dollars read short', () => {
    expect(formatUsd(0.4321)).toBe('$0.43')
    expect(formatUsd(12.6)).toBe('$13')
  })

  test('a rate-limit window reads as its name, its use and when it resets', () => {
    // Local times, so the test reads the same in any time zone.
    const now = new Date(2026, 9, 19, 10, 5).getTime()
    const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString()

    expect(limitParts({ kind: 'five_hour', percentUsed: 40.4, resetsAt: at(19, 14, 30) }, now)).toEqual({ name: '5h', used: '40%', reset: '14:30' })
    expect(limitParts({ kind: 'seven_day', percentUsed: 12, resetsAt: at(22, 9, 0) }, now)).toEqual({ name: '7d', used: '12%', reset: 'Thu 09:00' })
    expect(limitParts({ kind: 'spend_limit', percentUsed: 0.3 }, now)).toEqual({ name: 'spend', used: '<1%', reset: '' })
    expect(limitParts({ kind: 'weekly_opus', percentUsed: 100 }, now)).toEqual({ name: 'weekly_opus', used: '100%', reset: '' })
  })

  test('token counts read short', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(8_250)).toBe('8.3k')
    expect(formatTokens(57_340)).toBe('57k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })

  test('the cache line reads the latest request’s hit share and counts down its 5 minutes', () => {
    const reading = cacheReading({ input_tokens: 800, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 200, model: 'm' }, 1_000_000)
    expect(cacheParts(reading, 1_000_000)).toEqual({ hit: '90%', leftMs: 300_000 })
    expect(cacheParts(reading, 1_079_000).leftMs).toBe(221_000)
    expect(cacheParts(reading, 1_400_000).leftMs).toBe(0)
    expect(cacheParts(reading, 0).leftMs).toBe(300_000)
    expect(cacheParts(cacheReading({ input_tokens: 0, output_tokens: 0, model: 'm' }, 0), 0).hit).toBe('0%')
    expect(cacheParts(cacheReading({ input_tokens: 999, output_tokens: 0, cache_read_input_tokens: 1, model: 'm' }, 0), 0).hit).toBe('<1%')
  })
})
