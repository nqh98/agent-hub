import type { AgentInfo } from 'claude-code'

import type { AgentRow, AgentRowStatus, TurnEndReason } from '../types'

export type Rows = Record<string, AgentRow>
export type TreeLine = { row: AgentRow; depth: number }

export const MAX_AGENTS = 50

// Where a submission came from, as the task count reads it: a background
// task's notification, another session's message or an observer's report is
// the engine's, and starts no task; nor does another plugin's own prompt.
const ENGINE_ORIGINS = new Set([
  'task-notification', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'auto-continuation',
])

export const isPersonOrigin = (origin: { kind: string; name?: string; asUser?: true } | undefined): boolean =>
  origin === undefined || (origin.kind === 'plugin' ? origin.asUser === true : !ENGINE_ORIGINS.has(origin.kind))

// How long a turn.complete outranks a list snapshot that still says the agent
// runs: the list catches up a moment after the turn's end.
const END_GRACE_MS = 5000

const ENDED: ReadonlySet<AgentRowStatus> = new Set(['completed', 'failed', 'killed'])

export const isEnded = (status: AgentRowStatus): boolean => ENDED.has(status)

export const statusOf = (reason: TurnEndReason): AgentRowStatus =>
  reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'

const startOf = (row: AgentRow): number => row.startedAt ?? row.firstSeenAt

const blank = (id: string, now: number, task: number): AgentRow => ({
  id,
  task,
  type: 'agent',
  description: '',
  isTeammate: false,
  status: 'running',
  isListed: false,
  inList: false,
  firstSeenAt: now,
})

/** Folds one `$.agent.list()` snapshot into the rows. */
export function applyList(rows: Rows, list: readonly AgentInfo[], now: number, task = 0): Rows {
  const next: Rows = {}
  for (const [id, row] of Object.entries(rows)) next[id] = { ...row, inList: false }

  for (const info of list) {
    const prev = next[info.id] ?? blank(info.id, now, task)
    const isFreshEnd =
      prev.endedAt !== undefined &&
      isEnded(prev.status) &&
      !isEnded(info.status) &&
      now - prev.endedAt < END_GRACE_MS
    const status = isFreshEnd ? prev.status : info.status

    next[info.id] = {
      ...prev,
      type: info.type,
      description: info.description,
      name: info.name,
      parentId: info.parentId,
      isTeammate: info.teammateId !== undefined,
      status,
      isListed: true,
      inList: true,
      startedAt: prev.startedAt ?? (status === 'pending' ? undefined : now),
      endedAt: isEnded(status) || status === 'idle' ? (prev.endedAt ?? now) : undefined,
    }
  }

  // The engine lets an agent go from the list only after it ended.
  for (const row of Object.values(next)) {
    if (row.isListed && !row.inList && !isEnded(row.status)) {
      next[row.id] = {
        ...row,
        status: row.reason === undefined ? 'completed' : statusOf(row.reason),
        endedAt: row.endedAt ?? now,
      }
    }
  }

  return prune(next)
}

export function applyTurnStart(rows: Rows, id: string, now: number, task = 0): Rows {
  const prev = rows[id] ?? blank(id, now, task)

  return prune({
    ...rows,
    [id]: { ...prev, status: 'running', startedAt: prev.startedAt ?? now, endedAt: undefined, reason: undefined },
  })
}

export function applyTurnComplete(rows: Rows, id: string, reason: TurnEndReason, now: number, task = 0): Rows {
  const prev = rows[id] ?? blank(id, now, task)

  return prune({
    ...rows,
    [id]: {
      ...prev,
      status: prev.isTeammate ? 'idle' : statusOf(reason),
      startedAt: prev.startedAt ?? now,
      endedAt: now,
      reason,
    },
  })
}

/** Drops the oldest ended agents past `max`, the ones never listed first. */
export function prune(rows: Rows, max = MAX_AGENTS): Rows {
  const all = Object.values(rows)
  if (all.length <= max) return rows

  const ended = all
    .filter(row => isEnded(row.status))
    .sort((a, b) => Number(a.isListed) - Number(b.isListed) || (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const drop = new Set(ended.slice(0, all.length - max).map(row => row.id))

  return Object.fromEntries(all.filter(row => !drop.has(row.id)).map(row => [row.id, row]))
}

/**
 * The listed agents as an indented tree by `parentId`: roots still at work
 * first (oldest first), then finished ones (newest first).
 */
export function visibleTree(rows: Rows): TreeLine[] {
  const shown = Object.values(rows).filter(row => row.isListed)
  const ids = new Set(shown.map(row => row.id))
  const children = new Map<string, AgentRow[]>()
  const roots: AgentRow[] = []

  for (const row of shown) {
    if (row.parentId !== undefined && ids.has(row.parentId)) {
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row])
    } else {
      roots.push(row)
    }
  }

  const isBusy = (row: AgentRow, seen: Set<string>): boolean => {
    if (seen.has(row.id)) return false
    seen.add(row.id)

    return !isEnded(row.status) || (children.get(row.id) ?? []).some(child => isBusy(child, seen))
  }
  const busy = new Map(roots.map(row => [row.id, isBusy(row, new Set())]))
  roots.sort((a, b) => {
    const aBusy = busy.get(a.id) === true
    const bBusy = busy.get(b.id) === true
    if (aBusy !== bBusy) return aBusy ? -1 : 1

    return aBusy ? startOf(a) - startOf(b) : startOf(b) - startOf(a)
  })

  const lines: TreeLine[] = []
  const seen = new Set<string>()
  const walk = (row: AgentRow, depth: number) => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    lines.push({ row, depth })
    const kids = [...(children.get(row.id) ?? [])].sort((a, b) => startOf(a) - startOf(b))
    for (const child of kids) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)

  return lines
}

/**
 * The agents of the person's current prompt (`task`), and every agent still
 * at work from an earlier one. A prompt that started none shows none.
 */
export function latestTask(rows: Rows, task: number): Rows {
  return Object.fromEntries(
    Object.entries(rows).filter(([, row]) => (row.task ?? 0) === task || !isEnded(row.status)),
  )
}

export const hasActive = (rows: Rows): boolean =>
  Object.values(rows).some(row => row.isListed && !isEnded(row.status))

export const elapsedMs = (row: AgentRow, now: number): number =>
  Math.max(0, (row.endedAt ?? now) - startOf(row))

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
