import type { AgentActivity, CacheReading, RateLimitRow, TodoItem, TodoStatus, TokenUsage } from '../types'
import { redact } from './steps'
import type { Activity } from './steps'

const TODO_CHARS = 120
const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])

const blank = (): AgentActivity => ({ turns: [], steps: [], toolCount: 0, errorCount: 0 })

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : ''

  return redact(raw.length > TODO_CHARS ? `${raw.slice(0, TODO_CHARS - 1)}…` : raw)
}

const statusOf = (value: unknown): TodoStatus | undefined =>
  typeof value === 'string' && STATUSES.has(value) ? (value as TodoStatus) : undefined

/**
 * Folds one answered plan call into the agent's plan: TodoWrite replaces the
 * whole list, TaskCreate adds the task its result names, TaskUpdate changes or
 * deletes one. Any other call, or one whose shape is not as expected, leaves
 * the activity as it was.
 */
const activeOf = (value: unknown): { active?: string } => {
  const active = text(value)

  return active === '' ? {} : { active }
}

/**
 * A checklist after one answered plan call: TodoWrite replaces the whole list,
 * TaskCreate adds the task its result names, TaskUpdate changes or deletes
 * one. Undefined for any other call, or one whose shape is not as expected.
 */
export function nextPlan(
  todos: readonly TodoItem[],
  tool: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): TodoItem[] | undefined {
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    return args.todos.flatMap((one, index) => {
      const item = record(one)
      const status = statusOf(item.status)

      return status === undefined
        ? []
        : [{ id: `todo:${index}`, text: text(item.content), status, ...activeOf(item.activeForm) }]
    })
  }
  if (tool === 'TaskCreate') {
    const task = record(record(result).task)

    return typeof task.id === 'string'
      ? [...todos, { id: task.id, text: text(task.subject ?? args.subject), status: 'pending', ...activeOf(args.activeForm) }]
      : undefined
  }
  if (tool === 'TaskUpdate' && typeof args.taskId === 'string' && record(result).success !== false) {
    const id = args.taskId
    if (!todos.some(item => item.id === id)) return undefined

    return args.status === 'deleted'
      ? todos.filter(item => item.id !== id)
      : todos.map(item =>
          item.id === id
            ? {
                ...item,
                status: statusOf(args.status) ?? item.status,
                text: typeof args.subject === 'string' ? text(args.subject) : item.text,
                ...(typeof args.activeForm === 'string' ? activeOf(args.activeForm) : {}),
              }
            : item,
        )
  }

  return undefined
}

/**
 * Folds one answered plan call of an agent into its plan (nextPlan); with
 * `now`, an item it puts in progress is stamped then (stampStarts).
 */
export function applyPlan(
  activity: Activity,
  agentId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
  now?: number,
): Activity {
  const prev = activity[agentId] ?? blank()
  const before = prev.todos ?? []
  const planned = nextPlan(before, tool, args, result)
  if (planned === undefined) return activity
  const todos = now === undefined ? planned : stampStarts(before, planned, now)

  return { ...activity, [agentId]: { ...prev, todos } }
}

/**
 * The task the main conversation works on after a plan call: the one it just
 * put in progress, else the current one while still in progress, else any in
 * progress, else none.
 */
export function currentTaskAfter(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
  current: string | null,
): string | null {
  const started = after.find(
    item => item.status === 'in_progress' && before.find(one => one.id === item.id)?.status !== 'in_progress',
  )
  if (started !== undefined) return started.id
  if (current !== null && after.some(item => item.id === current && item.status === 'in_progress')) return current

  return after.find(item => item.status === 'in_progress')?.id ?? null
}

/** Stamps `now` on the items a plan call just put in progress; the others keep theirs. */
export function stampStarts(before: readonly TodoItem[], after: readonly TodoItem[], now: number): TodoItem[] {
  return after.map(item => {
    const was = before.find(one => one.id === item.id)
    if (item.status !== 'in_progress') return item
    if (was?.status === 'in_progress') return was.startedAt === undefined ? item : { ...item, startedAt: was.startedAt }

    return { ...item, startedAt: now }
  })
}

/** The checklist as the TaskList tool answers it, or undefined for any other shape. */
export function planFromTaskList(result: unknown): TodoItem[] | undefined {
  const tasks = record(result).tasks
  if (!Array.isArray(tasks)) return undefined

  return tasks.flatMap(one => {
    const task = record(one)
    const status = statusOf(task.status)

    return typeof task.id === 'string' && status !== undefined ? [{ id: task.id, text: text(task.subject), status }] : []
  })
}

/** The usage a turn.complete reports, in the API's spelling. */
export type TurnUsageIn = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  model: string
}

const add = (sum: TokenUsage | undefined, usage: TurnUsageIn): TokenUsage => ({
  input: (sum?.input ?? 0) + usage.input_tokens,
  output: (sum?.output ?? 0) + usage.output_tokens,
  cacheRead: (sum?.cacheRead ?? 0) + (usage.cache_read_input_tokens ?? 0),
  cacheWrite: (sum?.cacheWrite ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  model: usage.model,
})

const sum = (a: TokenUsage | undefined, b: TokenUsage): TokenUsage => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
  model: b.model,
})

/**
 * Adds a finished turn's token counts to the agent's total; the model is the
 * latest. The turn's steps were counted live: that count gives way to it.
 */
export function applyUsage(activity: Activity, agentId: string, usage: TurnUsageIn): Activity {
  const { live: _counted, ...prev } = activity[agentId] ?? blank()

  return { ...activity, [agentId]: { ...prev, usage: add(prev.usage, usage) } }
}

/** Adds one model request of the running turn, so the count moves while it runs. */
export function applyStepUsage(activity: Activity, agentId: string, usage: TurnUsageIn): Activity {
  const prev = activity[agentId] ?? blank()

  return { ...activity, [agentId]: { ...prev, live: add(prev.live, usage) } }
}

/** A turn that ends with no usage (an interrupt, an API error) keeps what its steps counted. */
export function settleLive(activity: Activity, agentId: string): Activity {
  const prev = activity[agentId]
  if (prev?.live === undefined) return activity
  const { live, ...rest } = prev

  return { ...activity, [agentId]: { ...rest, usage: sum(rest.usage, live) } }
}

/** What the agent has used so far: its ended turns and the running one's steps. */
export const usageOf = (one: AgentActivity | undefined): TokenUsage | undefined =>
  one?.live === undefined ? one?.usage : sum(one.usage, one.live)

/** Every token the agent's requests carried or produced, cached ones included. */
export const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite

// ponytail: the default 5-minute TTL; a 1-hour cache reads as expired early until the engine reports its TTL.
export const CACHE_TTL_MS = 5 * 60_000

export const cacheReading = (usage: TurnUsageIn, at: number): CacheReading => ({
  at,
  input: usage.input_tokens,
  read: usage.cache_read_input_tokens ?? 0,
  write: usage.cache_creation_input_tokens ?? 0,
})

/** `92%` of the latest request's input read from cache, and the time left before the cache expires (0 once it has). */
export function cacheParts(reading: CacheReading, nowMs: number): { hit: string; leftMs: number } {
  const total = reading.input + reading.read + reading.write
  const percent = total > 0 ? (reading.read / total) * 100 : 0

  return {
    hit: `${percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%`,
    // A clock read before the request (the pane's last tick) still counts no more than the TTL.
    leftMs: Math.min(CACHE_TTL_MS, Math.max(0, reading.at + CACHE_TTL_MS - nowMs)),
  }
}

export const formatUsd =(usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`

// The windows' short names, in the order they are drawn; another reads as its own name, after them.
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIMIT_ORDER = Object.keys(LIMIT_NAMES)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The windows as they are drawn: five hours, then seven days, then the rest as reported. */
export const orderLimits = (limits: readonly RateLimitRow[]): RateLimitRow[] =>
  [...limits].sort((a, b) => rank(a.kind) - rank(b.kind))

const rank = (kind: string): number => (LIMIT_ORDER.includes(kind) ? LIMIT_ORDER.indexOf(kind) : LIMIT_ORDER.length)

/** `14:30` for a time later today, `Thu 09:00` past it, in local time. */
function formatClock(at: Date, now: Date): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

  return at.toDateString() === now.toDateString() ? time : `${WEEKDAYS[at.getDay()]} ${time}`
}

/** `5h`, `40%`, `14:30`: the window's name, how much of it is used and when it starts over ("" when unknown). */
export function limitParts(limit: RateLimitRow, nowMs: number): { name: string; used: string; reset: string } {
  const used = limit.percentUsed > 0 && limit.percentUsed < 1 ? '<1' : String(Math.round(limit.percentUsed))
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

  return {
    name: LIMIT_NAMES[limit.kind] ?? limit.kind,
    used: `${used}%`,
    reset: Number.isNaN(resetsAt) ? '' : formatClock(new Date(resetsAt), new Date(nowMs)),
  }
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`

  return `${(count / 1_000_000).toFixed(1)}M`
}

/** `☑ 2/5`: the plan's finished items of all. */
export const planProgress = (todos: readonly TodoItem[]): string =>
  `☑ ${todos.filter(item => item.status === 'completed').length}/${todos.length}`
