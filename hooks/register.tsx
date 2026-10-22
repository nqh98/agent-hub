import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, ToolCallResult } from 'claude-code'

import type {
  AgentActivity,
  AgentRow,
  AgentRowStatus,
  ShellRow,
  ShellStatus,
  StepRow,
  StepStatus,
  TodoItem,
  TodoStatus,
  TurnEndReason,
} from '../types'
import { innerWidth, MIN_CARD_WIDTH, plural, spinnerFrame, stripRoom } from './card'
import { framed, row as layoutRow } from './layout'
import type { Line, Seg } from './layout'
import {
  applyPlan,
  currentTaskAfter,
  nextPlan,
  planFromTaskList,
  stampStarts,
  applyStepUsage,
  applyUsage,
  CACHE_TTL_MS,
  cacheParts,
  cacheReading,
  formatTokens,
  formatUsd,
  limitParts,
  orderLimits,
  planProgress,
  settleLive,
  totalTokens,
  usageOf,
} from './plan'
import {
  applyList,
  applyTurnComplete,
  applyTurnStart,
  elapsedMs,
  formatElapsed,
  hasActive,
  isEnded,
  latestTask,
  visibleTree,
} from './roster'
import {
  claimFiles,
  clip,
  commandLine,
  DONE_TAIL_LINES,
  endStatus,
  finalOutput,
  MAX_LOG_BYTES,
  patchRunning,
  readLog,
  shellFiles,
  startShell,
  TAIL_LINES,
  toBackground,
  visibleShells,
} from './shells'
import {
  applyStepEnd,
  applyStepStart,
  applyTurnBegin,
  applyTurnEnd,
  formatStepDuration,
  groupSteps,
  pruneActivity,
  stuckNote,
  summarize,
} from './steps'

export const PANE = 'agent-hub'
const TITLE = 'Agent Hub'
// The spinner's frame rate; the engine's roster is read every LIST_EVERY ticks.
const TICK_MS = 250
const LIST_EVERY = 4
// The keys of a tool.call input that are the engine's, not the tool's arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
// The checklist tool this mod gives every agent, subagents included (they
// have no TodoWrite or TaskCreate of their own): listed as mcp__<plugin>__<name>.
const CHECKLIST = 'checklist'
const CHECKLIST_TOOL = `mcp__agent-hub__${CHECKLIST}`
const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The whole checklist, every item, in order.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The item, imperative: "Read the layout file".' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'The item while in progress: "Reading the layout file".' },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
} as const

// The calls that write an agent's plan.
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

const agents = atom({ plugin: 'agent-hub', key: 'agents' } as const, {})
const activity = atom({ plugin: 'agent-hub', key: 'activity' } as const, {})
const tasks = atom({ plugin: 'agent-hub', key: 'tasks' } as const, [])
const currentTask = atom({ plugin: 'agent-hub', key: 'currentTask' } as const, null)
const taskLogs = atom({ plugin: 'agent-hub', key: 'taskLogs' } as const, {})
// Which log a step goes to: a subagent's activity, or a task of the main conversation.
type Log = 'agent' | 'task'
type Logs = Record<string, AgentActivity>
// The main conversation's calls that manage its checklist: not logged under a task.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
// The latest calls a task in progress lists under it.
const TASK_LOG_STEPS = 6
const now = atom({ plugin: 'agent-hub', key: 'now' } as const, 0)
const selected = atom({ plugin: 'agent-hub', key: 'selected' } as const, null)
const sendCount = atom({ plugin: 'agent-hub', key: 'sendCount' } as const, 0)
const confirmStop = atom({ plugin: 'agent-hub', key: 'confirmStop' } as const, null)
const isExpanded = atom({ plugin: 'agent-hub', key: 'isExpanded' } as const, true)
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' }
const task = atom({ plugin: 'agent-hub', key: 'task' } as const, 0)
const showAll = atom({ plugin: 'agent-hub', key: 'showAll' } as const, false)
const contextFill = atom({ plugin: 'agent-hub', key: 'context' } as const, null)
const promptCache = atom({ plugin: 'agent-hub', key: 'cache' } as const, null)
// The context bar: the used part solid in Claude's orange, red once the
// window is 80% full (compaction is near); the rest a light shade.
const BAR_COLOR = 'claude'
const BAR_FULL_COLOR = 'error'
const sessionCost = atom({ plugin: 'agent-hub', key: 'sessionCostUsd' } as const, null)
const rateLimits = atom({ plugin: 'agent-hub', key: 'rateLimits' } as const, [])
const shells = atom({ plugin: 'agent-hub', key: 'shells' } as const, [])
// The steps a running agent's expanded card lists, and the calls under its
// item in progress: few, so a card stays short; a finished agent's card
// folds to one line, and the detail view lists them all.
const CARD_STEPS = 3
const CARD_TASK_STEPS = 3
// The shells' logs are read every SHELL_EVERY ticks while one runs; the
// tasks dir is looked for again every SCAN_EVERY polls until found.
const SHELL_EVERY = 2
const SCAN_EVERY = 8
// The size the pane asks for: columns docked beside a fullscreen transcript,
// rows seated inline above the prompt. A size the person set wins.
const OPEN_SIZE = { columns: 80, rows: 32 } as const
// How long a first press of stop waits for the second.
const CONFIRM_MS = 3000

const GLYPH: Record<AgentRowStatus, string> = {
  pending: '◌',
  running: '●',
  waiting: '◐',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '⊘',
}

const LABEL: Record<AgentRowStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const COLOR: Record<AgentRowStatus, string> = {
  pending: 'inactive',
  running: 'claude',
  waiting: 'warning',
  idle: 'inactive',
  completed: 'success',
  failed: 'error',
  killed: 'error',
}

const TURN_LABEL: Record<TurnEndReason, string> = {
  answer: 'done',
  aborted: 'stopped',
  refusal: 'refused',
  error: 'failed',
}

const STEP_GLYPH: Record<StepStatus, string> = { running: '●', done: '✓', error: '✗', denied: '⊘' }
const STEP_COLOR: Record<StepStatus, string> = { running: 'claude', done: 'success', error: 'error', denied: 'warning' }
const TODO_COLOR: Record<TodoStatus, string> = { pending: 'inactive', in_progress: 'claude', completed: 'success' }
// The main checklist drawn as Claude Code draws its own task list.
const TASK_GLYPH: Record<TodoStatus, string> = { pending: '□', in_progress: '■', completed: '✔' }
const TASK_COLOR: Record<TodoStatus, string | undefined> = { pending: undefined, in_progress: 'claude', completed: 'success' }
const SHELL_GLYPH: Record<ShellStatus, string> = { running: '●', done: '✓', failed: '✗', stopped: '⊘' }
const SHELL_COLOR: Record<ShellStatus, string> = { running: 'claude', done: 'success', failed: 'error', stopped: 'warning' }
const TASK_WORD: Record<TodoStatus, string> = { pending: 'pending', in_progress: 'in progress', completed: 'done' }

// The pane's heading, "Subagents": Claude's orange, as the theme spells it.
const TITLE_COLOR = 'claude'
/** Claude's mascot, drawn in blocks as Claude Code draws it at start. */
const MASCOT = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']
/**
 * "AGENT HUB" in quarter blocks, as the mascot is drawn: three rows like it,
 * half a column between letters.
 */
const NAME_ART = [
  '▟▛▜▙▗█▀▀▘█▛▀▘█▙ █▌▀▜█▀▘ ▐█ █▌█▌▐█▐█▀█▖',
  '█▙▟█▐█▗▄▖█▛▀ █▛██▌ ▐█   ▐█▀█▌█▌▐█▐█▀█▖',
  '█▌▐█▝█▄█▌█▙▄▖█▌▝█▌ ▐█   ▐█ █▌▜▙▟▛▐█▄█▘',
]
/** Mascot, gap and name: the columns the drawn header needs. */
const HEADER_WIDTH = 9 + 2 + NAME_ART[0]!.length

const openKey = (id: string) => `open:${id}`
const childKey = (id: string) => `child:${id}`

let ticks = 0
// Where the engine writes the session's command logs, once found, and the
// log files already given out or passed over. The module's own: a reload
// looks again.
let tasksDir: string | undefined
let seenFiles: ReadonlySet<string> = new Set()
let polls = 0

const sanitize = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

// The engine keeps a session's command logs in `<tmp>/claude-<uid>/<project>/<session>/tasks`:
// the project's folder guessed from the session's start first, then every one.
async function findTasksDir($: EngineInterface): Promise<string | undefined> {
  const id = await $.session.id()
  const guesses = [sanitize(await $.session.root()), sanitize(await $.session.cwd())]
  const own = await $.env.get('CLAUDE_CODE_TMPDIR')
  for (const tmp of [own, '/private/tmp', '/tmp']) {
    if (tmp === undefined) continue
    const roots = (await $.fs.list(tmp).catch(() => [])).filter(one => one.kind === 'dir' && one.name.startsWith('claude-'))
    for (const root of roots) {
      const projects = (await $.fs.list(`${tmp}/${root.name}`).catch(() => [])).filter(one => one.kind === 'dir')
      const names = [...new Set([...guesses, ...projects.map(one => one.name)])]
      for (const name of names) {
        const dir = `${tmp}/${root.name}/${name}/${id}/tasks`
        if (await $.fs.exists(dir).catch(() => false)) return dir
      }
    }
  }

  return undefined
}

// Found: the logs there before any shell now waiting began are someone else's.
async function useTasksDir($: EngineInterface, dir: string) {
  if (tasksDir === dir) return
  tasksDir = dir
  const waiting = (await read($, shells)).filter(one => one.status === 'running' && one.taskId === undefined)
  const since = Math.min(await $.clock.now(), ...waiting.map(one => one.startedAt))
  const entries = await $.fs.list(dir).catch(() => [])
  seenFiles = new Set([...seenFiles, ...shellFiles(entries, since)])
}

// Reads each running shell's log, when it grew, and gives new logs to the shells waiting for one.
async function pollShells($: EngineInterface) {
  const before = await read($, shells)
  if (!before.some(one => one.status === 'running')) return
  if (tasksDir === undefined) {
    if (polls++ % SCAN_EVERY !== 0) return
    const found = await findTasksDir($)
    if (found === undefined) return
    await useTasksDir($, found)
  }
  const dir = tasksDir!
  let list = before
  if (list.some(one => one.status === 'running' && !one.isBackground && one.taskId === undefined)) {
    const entries = await $.fs.list(dir).catch(() => undefined)
    if (entries !== undefined) {
      const claimed = claimFiles(list, shellFiles(entries), seenFiles)
      seenFiles = claimed.seen
      if (claimed.shells.some((one, i) => one.taskId !== list[i]?.taskId)) {
        const given = new Map(claimed.shells.map(one => [one.id, one.taskId]))
        list = await update($, shells, rows =>
          rows.map(one => (one.taskId === undefined && given.get(one.id) !== undefined ? { ...one, taskId: given.get(one.id) } : one)),
        )
      }
    }
  }
  for (const row of list) {
    if (row.status !== 'running' || row.taskId === undefined) continue
    const path = `${dir}/${row.taskId}.output`
    const stat = await $.fs.stat(path).catch(() => undefined)
    const t = await $.clock.now()
    // A foreground log goes as its command ends, the result telling how; a
    // background one gone is a command stopped.
    if (stat === undefined) {
      if (row.isBackground) await update($, shells, rows => patchRunning(rows, row.id, { status: 'stopped', endedAt: t }))
      continue
    }
    if (stat.size === row.size) continue
    if (stat.size > MAX_LOG_BYTES) {
      const tail = [`… ${formatTokens(stat.size)}B of output, too much to tail here`]
      await update($, shells, rows => patchRunning(rows, row.id, { tail, size: stat.size }))
      continue
    }
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    const log = readLog(text)
    const exitCode = row.isBackground ? log.exitCode : undefined
    const end: Partial<ShellRow> =
      exitCode === undefined ? {} : { status: exitCode === 0 ? 'done' : 'failed', exitCode, endedAt: t }
    await update($, shells, rows => patchRunning(rows, row.id, { tail: log.tail, size: stat.size, ...end }))
  }
}

// A command's call settled: moved to the background it keeps running under
// the id the result gives; otherwise it ended, its output the result's own.
async function settleShell($: EngineInterface, id: string, ran: ToolCallResult) {
  const record = typeof ran.result === 'object' && ran.result !== null ? (ran.result as Record<string, unknown>) : {}
  const taskId = typeof record.backgroundTaskId === 'string' ? record.backgroundTaskId : undefined
  if (taskId !== undefined && ran.deny === undefined) {
    const named = /(\/\S+)\/b[a-z0-9]+\.output/.exec(ran.text ?? '')?.[1]
    if (named !== undefined && tasksDir === undefined) await useTasksDir($, named)
    await update($, shells, rows => toBackground(rows, id, taskId))

    return
  }
  const t = await $.clock.now()
  const { output, exitCode } = finalOutput(ran.result, ran.text)
  const { tail } = readLog(output)
  const status = endStatus(ran)
  const code = exitCode ?? (status === 'done' ? 0 : undefined)
  await update($, shells, rows =>
    rows.map(one =>
      one.id === id ? { ...one, status, endedAt: t, exitCode: code, tail: tail.length > 0 ? tail : one.tail } : one,
    ),
  )
}

// Reads the engine's roster and folds it in, writing only on a change so an
// idle session redraws nothing.
async function refresh($: EngineInterface) {
  let list: AgentInfo[]
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const t = await $.clock.now()
  const current = await read($, task)
  const before = await read($, agents)
  if (JSON.stringify(applyList(before, list, t, current)) !== JSON.stringify(before)) {
    await update($, agents, rows => applyList(rows, list, t, current))
  }

  const keep = new Set(Object.keys(await read($, agents)))
  const acts = await read($, activity)
  if (pruneActivity(acts, keep) !== acts) {
    await update($, activity, a => pruneActivity(a, keep))
  }
  const shown = await read($, selected)
  if (shown !== null && !keep.has(shown)) {
    await update($, selected, () => null)
  }
}

async function tick($: EngineInterface) {
  ticks += 1
  if (ticks % LIST_EVERY === 0) await refresh($)
  if (ticks % SHELL_EVERY === 0) await pollShells($).catch(() => undefined)
  const isShellBusy = (await read($, shells)).some(one => one.status === 'running')
  const isTaskBusy = Object.values(await read($, taskLogs)).some(log => log.steps.at(-1)?.status === 'running')
  const isTaskOpen = (await read($, tasks)).some(item => item.status === 'in_progress')
  // The cache countdown ticks until a tick past its expiry.
  const cache = await read($, promptCache)
  const isCacheWarm = cache !== null && (await read($, now)) < cache.at + CACHE_TTL_MS
  if (hasActive(await read($, agents)) || isTaskBusy || isTaskOpen || isShellBusy || isCacheWarm) {
    const t = await $.clock.now()
    await update($, now, () => t)
  }
}

// The state library takes each value by its own reference: one write per log.
const writeLog = ($: EngineInterface, log: Log, change: (logs: Logs) => Logs) =>
  log === 'task' ? update($, taskLogs, change) : update($, activity, change)

// A step ends in `log` under `key`.
async function endStep($: EngineInterface, log: Log, key: string, stepId: string, ran: ToolCallResult) {
  const t = await $.clock.now()
  const [status, note]: [Exclude<StepStatus, 'running'>, string | undefined] =
    ran.deny !== undefined ? ['denied', ran.deny] : ran.isError === true ? ['error', ran.text] : ['done', undefined]
  await writeLog($, log, a => applyStepEnd(a, key, stepId, status, t, note))
}

async function failStep($: EngineInterface, log: Log, key: string, stepId: string) {
  const t = await $.clock.now()
  await writeLog($, log, a => applyStepEnd(a, key, stepId, 'error', t, 'cancelled'))
}

// Shows one agent (or the list, for null) and puts the focus ring on `key`
// once the next drawing has it; a pane not holding the keys refuses, harmlessly.
async function show($: EngineInterface, id: string | null, key: string) {
  await update($, selected, () => id)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// Puts an agent's transcript in the main view, or the main conversation back
// for undefined; only a press of the person's own moves it.
async function view($: EngineInterface, agentId: string | undefined) {
  const moved = await $.ui.view(agentId === undefined ? {} : { agentId })
  if (moved.deny !== undefined) $.ui.toast(`Agent Hub: ${moved.deny}`)
}

const msgKey = (count: number) => `msg:${count}`

// Sends the person's text to the agent's loop, as SendMessage would, then
// draws the field anew, empty, with the focus back on it.
async function send($: EngineInterface, row: AgentRow, text: string) {
  const message = text.trim()
  if (message === '') return

  const sent = await $.session.send({ to: { agentId: row.id }, text: message })
  if (!sent.isDelivered) {
    $.ui.toast(`Agent Hub: not sent: ${sent.reason}`)

    return
  }
  const count = await update($, sendCount, n => n + 1)
  $.ui.toast(`Agent Hub: message sent to ${row.type}`)
  await $.ui.focus({ requestId: PANE, key: msgKey(count) }).catch(() => undefined)
}

// The first press asks; a second within CONFIRM_MS stops the agent's task.
async function stop($: EngineInterface, row: AgentRow) {
  if ((await read($, confirmStop)) !== row.id) {
    await update($, confirmStop, () => row.id)
    $.clock.after(CONFIRM_MS, () => void update($, confirmStop, id => (id === row.id ? null : id)).catch(() => undefined))

    return
  }
  await update($, confirmStop, () => null)
  const ran = await $.tool.call({ tool: 'TaskStop', task_id: row.id })
  if (ran.deny !== undefined || ran.isError === true) {
    $.ui.toast(`Agent Hub: could not stop ${row.type}: ${ran.deny ?? ran.text ?? 'unknown error'}`)

    return
  }
  $.ui.toast(`Agent Hub: stopped ${row.type}`)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-hub', description: 'Open Agent Hub: context, tasks and subagents' })
    await $.tool
      .register({
        name: CHECKLIST,
        description:
          'Write your task checklist so the person can follow your progress live in the Agent Hub pane. ' +
          'Send the whole list every time. Use it for any job of three or more steps: write the list first, ' +
          'mark an item in_progress when you start it and completed as soon as it is done, one in progress at a time.',
        inputSchema: CHECKLIST_SCHEMA,
        isDeferred: false,
      })
      .catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE, ...OPEN_SIZE })
    // A foreground command running when the mod reloaded has no result to
    // come: it is over as far as the pane can tell. A background one keeps its log.
    const reloadedAt = await $.clock.now()
    await update($, shells, list =>
      list.map(one => (one.status === 'running' && !one.isBackground ? { ...one, status: 'stopped' as const, endedAt: reloadedAt } : one)),
    ).catch(() => undefined)
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    // The checklist as it stands when the mod loads; each plan call keeps it current after.
    void $.tool
      .call({ tool: 'TaskList' })
      .then(ran => {
        const list = planFromTaskList(ran.result)
        if (list === undefined) return undefined

        return Promise.all([
          update($, tasks, () => list),
          update($, currentTask, () => currentTaskAfter([], list, null)),
        ])
      })
      .catch(() => undefined)
    void $.session
      .usage()
      .then(({ cost, context, rateLimits: limits }) =>
        Promise.all([
          cost === undefined ? undefined : update($, sessionCost, () => cost.usd),
          update($, rateLimits, () => orderLimits(limits)),
          context.tokens === undefined
            ? undefined
            : update($, contextFill, () => ({ tokens: context.tokens ?? 0, window: context.window })),
        ]),
      )
      .catch(() => undefined)

    return next(e)
  })

  // Each prompt the person sends starts a task; a slash command or a prompt
  // the engine made itself does not, so opening the pane hides nothing.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      await update($, task, n => n + 1).catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine raises a measurement as the session's figures move: the cost is /cost's own.
  on('session.measure', async ($, e, next) => {
    const usd = e.cost?.usd
    if (usd !== undefined) await update($, sessionCost, () => usd).catch(() => undefined)
    if (e.changed.includes('rateLimits')) {
      await update($, rateLimits, () => orderLimits(e.rateLimits)).catch(() => undefined)
    }
    const tokens = e.context.tokens
    if (tokens !== undefined) {
      await update($, contextFill, () => ({ tokens, window: e.context.window })).catch(() => undefined)
    }

    return next(e)
  })

  // Each model request of a subagent's turn: its tokens count at once, not
  // only when the turn ends; the main conversation's sets the cache line.
  // The stream passes through untouched first.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (agentId !== undefined && usage !== null) {
      await update($, activity, a => applyStepUsage(a, agentId, usage)).catch(() => undefined)
    } else if (usage !== null) {
      const t = await $.clock.now()
      await update($, promptCache, () => cacheReading(usage, t)).catch(() => undefined)
    }

    return result
  })

  on('command.run', { command: 'agent-hub' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, ...OPEN_SIZE })

    return { text: 'Agent Hub pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const t = await $.clock.now()
      const current = await read($, task)
      await update($, agents, rows => applyTurnStart(rows, id, t, current))
      await update($, activity, a => applyTurnBegin(a, id, e.turnId, e.text, t))
      void refresh($).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const t = await $.clock.now()
      const current = await read($, task)
      await update($, agents, rows => applyTurnComplete(rows, id, e.reason, t, current))
      await update($, activity, a => applyTurnEnd(a, id, e.turnId, e.reason, t))
      const usage = e.usage
      await update($, activity, a => (usage === undefined ? settleLive(a, id) : applyUsage(a, id, usage)))
      void refresh($).catch(() => undefined)
    }

    return next(e)
  })

  // Every Bash call, the main conversation's and each subagent's, is a shell
  // in the pane. The watching fails quietly; the call's own failure is the call's.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = await $.clock.now().catch(() => 0)
    const id = e.tool_use_id ?? `shell:${t}`
    const row: ShellRow = {
      id,
      command: String(e.command ?? ''),
      description: typeof e.description === 'string' && e.description !== '' ? e.description : undefined,
      agentId: e.agentId,
      task: await read($, task).catch(() => 0),
      status: 'running',
      isBackground: e.run_in_background === true,
      startedAt: t,
      tail: [],
    }
    await update($, shells, list => startShell(list, row)).catch(() => undefined)
    // The tasks dir not found yet: the next poll looks for it.
    if (tasksDir === undefined) polls = 0
    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (error) {
      const ended = await $.clock.now().catch(() => t)
      await update($, shells, list => patchRunning(list, id, { status: 'stopped', endedAt: ended })).catch(() => undefined)
      throw error
    }
    await settleShell($, id, ran).catch(() => undefined)

    return ran
  })

  // A background command stopped by its id ends its shell.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const stopped = e.task_id ?? e.shell_id
    if (stopped !== undefined && ran.deny === undefined && ran.isError !== true) {
      const t = await $.clock.now().catch(() => 0)
      await update($, shells, list =>
        list.map(one => (one.taskId === stopped && one.status === 'running' ? { ...one, status: 'stopped' as const, endedAt: t } : one)),
      ).catch(() => undefined)
    }

    return ran
  })

  // Watching must never stand in a tool's way: a failure here passes the call on.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const tool = String(e.tool)
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))

    // This mod's own checklist tool, answered here: a subagent's list goes to
    // its card, the main conversation's to the Tasks group.
    if (tool === CHECKLIST_TOOL) {
      const asWrite = { todos: args.todos }
      if (agentId === undefined) {
        const before = await read($, tasks)
        const planned = nextPlan(before, 'TodoWrite', asWrite, {})
        if (planned !== undefined) {
          const after = stampStarts(before, planned, await $.clock.now())
          await update($, tasks, () => after)
          await update($, currentTask, current => currentTaskAfter(before, after, current))
        }
      } else {
        const t = await $.clock.now()
        await update($, activity, a => applyPlan(a, agentId, 'TodoWrite', asWrite, {}, t))
      }
      const count = Array.isArray(args.todos) ? args.todos.length : 0

      // A registered tool's result is text (or content blocks), never an object.
      const saved = `Checklist saved (${plural(count, 'item')}); the person sees it in the Agent Hub pane.`

      return { result: saved, text: saved }
    }

    // Logs the call as a step of `key` in `log`, running until the call settles.
    const logged = async (log: Log, key: string): Promise<ToolCallResult> => {
      const t = await $.clock.now()
      const stepId = e.tool_use_id ?? `${key}:${t}`
      const step: StepRow = { id: stepId, tool, summary: summarize(tool, args), status: 'running', startedAt: t }
      await writeLog($, log, a => applyStepStart(a, key, step))

      // An Agent call is left unawaited: the hook stays out of the child's spawn,
      // and the step settles when the call does.
      if (tool === 'Agent') {
        const pending = next(e)
        void pending.then(
          ran => endStep($, log, key, stepId, ran),
          () => failStep($, log, key, stepId),
        ).catch(() => undefined)

        return pending
      }
      try {
        const ran = await next(e)
        await endStep($, log, key, stepId, ran)

        return ran
      } catch (error) {
        await failStep($, log, key, stepId)
        throw error
      }
    }

    // The main conversation: its checklist calls keep the Tasks group current,
    // and any other call is logged under the task it works on, if one.
    if (agentId === undefined) {
      if (PLAN_TOOLS.has(tool)) {
        const ran = await next(e)
        if (ran.deny === undefined && ran.isError !== true) {
          const before = await read($, tasks)
          const planned = nextPlan(before, tool, args, ran.result)
          const after = planned === undefined ? undefined : stampStarts(before, planned, await $.clock.now())
          if (after !== undefined) {
            await update($, tasks, () => after)
            await update($, currentTask, current => currentTaskAfter(before, after, current))
          }
        }

        return ran
      }
      const taskId = TASK_TOOLS.has(tool) ? null : await read($, currentTask)

      return taskId === null ? next(e) : logged('task', taskId)
    }

    const ran = logged('agent', agentId)
    if (!PLAN_TOOLS.has(tool)) return ran
    const settled = await ran
    if (settled.deny === undefined && settled.isError !== true) {
      const t = await $.clock.now()
      await update($, activity, a => applyPlan(a, agentId, tool, args, settled.result, t))
    }

    return settled
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // Mobile draws no text field: there the message box is left out.
    const Input = 'Input' in table ? table.Input : undefined
    const rows = await read($, agents)
    const acts = await read($, activity)
    const t = await read($, now)
    const shown = await read($, selected)
    const sends = await read($, sendCount)
    const asking = await read($, confirmStop)
    const expanded = await read($, isExpanded)
    const cost = await read($, sessionCost)
    const fill = await read($, contextFill)
    const cache = await read($, promptCache)
    const limits = await read($, rateLimits)
    const isAll = await read($, showAll)
    const checklist = await read($, tasks)
    const logs = await read($, taskLogs)
    const shellRows = await read($, shells)
    const currentPrompt = await read($, task)
    // The list keeps to the latest task unless the person asked for all;
    // the detail view still finds any agent's children.
    const allLines = visibleTree(rows)
    const lines = isAll ? allLines : visibleTree(latestTask(rows, currentPrompt))
    const hidden = allLines.length - lines.length
    const frame = spinnerFrame(t, TICK_MS)
    const columns = e.props.bodyColumns
    // The agent whose transcript the main view shows, if any.
    const viewing = e.props.view.agentId
    const banner = viewing !== undefined && (
      <Box flexDirection="row" gap={2}>
        <Text color="warning">
          Viewing {rows[viewing]?.type ?? 'an agent'}'s transcript
        </Text>
        <Button key="main" plain hotkey="m" label="main conversation" onPress={() => view($, undefined)} />
      </Box>
    )

    const timeOf = (row: AgentRow) => formatElapsed(elapsedMs(row, Math.max(t, row.startedAt ?? 0)))
    const countsOf = (act: AgentActivity | undefined) =>
      plural(act?.toolCount ?? 0, 'tool') +
      (act && act.errorCount > 0 ? ` · ${plural(act.errorCount, 'error')}` : '') +
      (act?.todos?.length ? ` · ${planProgress(act.todos)}` : '')
    // The title row's right end: the time, and the tokens once a turn reported them.
    const rightOf = (row: AgentRow) => {
      const usage = usageOf(acts[row.id])

      return usage === undefined ? timeOf(row) : `${timeOf(row)} · ${formatTokens(totalTokens(usage))} tok`
    }
    const stepTime = (step: StepRow) =>
      formatStepDuration((step.endedAt ?? Math.max(t, step.startedAt)) - step.startedAt)

    // Rows of styled text as a Button's children: one Text a run, a newline between rows.
    const drawLines = (drawn: readonly Line[]) =>
      drawn.flatMap((cardLine, index) => [
        ...cardLine.map(seg => (
          <Text color={seg.color} dimColor={seg.dim} bold={seg.bold} strikethrough={seg.strike}>
            {seg.text}
          </Text>
        )),
        ...(index < drawn.length - 1 ? ['\n'] : []),
      ])

    // What a card's top border carries: the status glyph and type on the left,
    // the time and tokens on the right.
    const titleOf = (row: AgentRow, isDone: boolean, style: (segs: Seg[]) => Seg[] = segs => segs) => ({
      left: style([
        { text: GLYPH[row.status], color: COLOR[row.status] },
        { text: ` ${row.type}`, color: 'text', bold: !isDone },
      ]),
      right: style([{ text: rightOf(row), color: 'text' }]),
    })

    // The task component, one for every checklist the pane shows: the main
    // conversation's (the Tasks group) and each subagent's (in its card and
    // its detail). A heading with a tally, the item in progress, then every
    // item while any is open, drawn as Claude Code draws its own list.
    const workingOf = (list: readonly TodoItem[]) => list.find(item => item.status === 'in_progress')
    const isOpen = (list: readonly TodoItem[]) => list.some(item => item.status !== 'completed')
    const tallyOf = (list: readonly TodoItem[]) => {
      const parts = (['in_progress', 'pending', 'completed'] as const)
        .map(status => [status, list.filter(item => item.status === status).length] as const)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${TASK_WORD[status]}`)

      return parts.length > 0 ? parts.join(' · ') : 'none'
    }
    const taskHeading = (list: readonly TodoItem[], extra: readonly string[] = []) => (
      <Text>
        <Text bold>
          <Text color={TITLE_COLOR}>Tasks</Text>: {tallyOf(list)}
        </Text>
        <Text dimColor>{extra.filter(Boolean).map(part => ` · ${part}`).join('')}</Text>
      </Text>
    )
    const workingLine = (list: readonly TodoItem[], facts: readonly string[] = []) => {
      const item = workingOf(list)
      const shown = facts.filter(Boolean)

      return (
        item !== undefined && (
          <Text color={TODO_COLOR.in_progress}>
            ✳ {item.active ?? item.text}…{shown.length > 0 && <Text dimColor> ({shown.join(' · ')})</Text>}
          </Text>
        )
      )
    }
    // The items, `logs` (the main conversation's) listing each in-progress
    // item's latest calls under it and folding a finished one's to a count.
    const taskItems = (list: readonly TodoItem[], logs?: Record<string, AgentActivity>) =>
      list.map((item, index) => {
        const log = logs?.[item.id]
        const steps = log?.steps ?? []
        const shownSteps = item.status === 'in_progress' ? steps.slice(-TASK_LOG_STEPS) : []
        const earlier = steps.length - shownSteps.length
        const tally =
          item.status === 'completed' && log !== undefined && log.toolCount > 0
            ? ` · ${plural(log.toolCount, 'tool')}${log.errorCount > 0 ? ` · ${plural(log.errorCount, 'error')}` : ''}`
            : ''

        return (
          <Box flexDirection="column" key={`task:${item.id}`}>
            <Text>
              <Text dimColor>{index === 0 ? '  ⎿ ' : '    '}</Text>
              <Text color={TASK_COLOR[item.status]}>{TASK_GLYPH[item.status]}</Text>{' '}
              <Text
                bold={item.status === 'in_progress'}
                dimColor={item.status === 'completed'}
                strikethrough={item.status === 'completed'}
              >
                {item.text}
              </Text>
              {tally !== '' && <Text dimColor>{tally}</Text>}
            </Text>
            {item.status === 'in_progress' && earlier > 0 && (
              <Text dimColor>{`      … ${plural(earlier, 'earlier call')}`}</Text>
            )}
            {shownSteps.map(step => (
              <Box flexDirection="row" key={`task-step:${step.id}`} marginLeft={6}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor={step.status !== 'running'}>
                    <Text color={STEP_COLOR[step.status]}>{step.status === 'running' ? frame : STEP_GLYPH[step.status]}</Text>{' '}
                    {step.tool} <Text dimColor>{step.note ? `${step.summary} — ${step.note}` : step.summary}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text dimColor>{stepTime(step)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )
      })
    // The same component as rows of a card, which holds only text.
    // `stepRows` draws the agent's calls since the item in progress began,
    // which then sit under it, as the Tasks group lists the main conversation's.
    const taskLines = (list: readonly TodoItem[], inner: number, stepRows?: (one: TodoItem) => Line[]): Line[] => {
      const item = workingOf(list)

      return [
        ...layoutRow(
          [
            { text: 'Tasks', color: TITLE_COLOR, bold: true },
            { text: `: ${tallyOf(list)}`, bold: true },
          ],
          undefined,
          inner,
        ),
        ...(item === undefined
          ? []
          : layoutRow([{ text: `✳ ${item.active ?? item.text}…`, color: TODO_COLOR.in_progress }], undefined, inner)),
        ...(isOpen(list)
          ? list.flatMap((one, index) =>
              layoutRow(
                [
                  { text: index === 0 ? '⎿ ' : '  ', dim: true },
                  { text: TASK_GLYPH[one.status], color: TASK_COLOR[one.status] },
                  { text: ' ' },
                  {
                    text: one.text,
                    bold: one.status === 'in_progress',
                    dim: one.status === 'completed',
                    strike: one.status === 'completed',
                  },
                ],
                undefined,
                inner,
                4,
              ).concat(one.status === 'in_progress' && stepRows !== undefined ? stepRows(one) : []),
            )
          : []),
      ]
    }

    // A card in the list is one Button, laid out by hand: Tab lands on the
    // whole card and the ring inverts all of it; Enter opens it.
    const card = (row: AgentRow, depth: number) => {
      const act = acts[row.id]
      const steps = act?.steps ?? []
      const isDone = isEnded(row.status)
      const width = Math.max(MIN_CARD_WIDTH, columns - depth * 2)
      const inner = innerWidth(width)
      const counts = countsOf(act)
      const current = steps.at(-1)
      const lastError = [...steps].reverse().find(step => step.status === 'error' || step.status === 'denied')
      const stuck = isDone ? undefined : stuckNote(act, row.startedAt ?? row.firstSeenAt, t)
      const strip = steps.slice(-stripRoom(width, counts))
      const listed = steps.slice(-CARD_STEPS)
      const earlier = steps.length - listed.length
      const stepSegs = (step: StepRow, glyph: string): Seg[] => [
        { text: glyph, color: STEP_COLOR[step.status] },
        { text: ` ${step.tool} `, dim: step.status !== 'running' },
        { text: step.note ? `${step.summary} — ${step.note}` : step.summary, dim: true },
      ]
      const stepLines = (step: StepRow) =>
        layoutRow(
          stepSegs(step, step.status === 'running' ? frame : STEP_GLYPH[step.status]),
          [{ text: stepTime(step), dim: true }],
          inner,
        )
      const note = (text: string) => layoutRow([{ text, dim: true }], undefined, inner)
      // The calls since the item in progress began, under it, indented past its glyph.
      const todos = act?.todos ?? []
      const working = workingOf(todos)
      const underTask = (item: TodoItem): Line[] => {
        const since = item.startedAt === undefined ? steps : steps.filter(step => step.startedAt >= item.startedAt!)
        // Compact keeps the latest call alone.
        const shown = since.slice(expanded ? -CARD_TASK_STEPS : -1)
        const hidden = since.length - shown.length

        return [
          ...(hidden > 0 ? layoutRow([{ text: `      … ${plural(hidden, 'earlier call')}`, dim: true }], undefined, inner) : []),
          ...shown.flatMap(step =>
            layoutRow(
              [{ text: '      ' }, ...stepSegs(step, step.status === 'running' ? frame : STEP_GLYPH[step.status])],
              [{ text: stepTime(step), dim: true }],
              inner,
              8,
            ),
          ),
        ]
      }
      // While an item is in progress its calls show under it, not in a list of their own.
      const isTaskLog = working !== undefined

      const body: Line[] = [
        ...layoutRow(
          [{ text: row.description || row.name || row.id, dim: true }],
          isDone ? [{ text: `${counts} · ${LABEL[row.status]}` }] : undefined,
          inner,
        ),
        ...(!isDone && todos.length > 0 ? taskLines(todos, inner, isTaskLog ? underTask : undefined) : []),
        ...(expanded && !isDone && !isTaskLog && earlier > 0 ? note(`… ${plural(earlier, 'earlier step')} · enter: all`) : []),
        ...(expanded && !isDone && !isTaskLog ? listed.flatMap(stepLines) : []),
        ...(expanded && !isDone && !isTaskLog && current === undefined ? note('starting…') : []),
        ...(!expanded && !isDone && !isTaskLog
          ? current === undefined
            ? note(row.status === 'running' ? 'starting…' : LABEL[row.status])
            : stepLines(current)
          : []),
        ...(!expanded && !isDone && lastError !== undefined && lastError !== current
          ? layoutRow(stepSegs(lastError, STEP_GLYPH[lastError.status]), undefined, inner)
          : []),
        ...(stuck !== undefined ? layoutRow([{ text: `⚠ ${stuck}`, color: 'warning' }], undefined, inner) : []),
        ...(!isDone
          ? layoutRow(
              strip.map(step => ({ text: STEP_GLYPH[step.status], color: STEP_COLOR[step.status] })),
              [{ text: counts, dim: true }],
              inner,
            )
          : []),
      ]
      // A finished card is drawn dim throughout.
      const dimmed = (segs: Seg[]) => (isDone ? segs.map(seg => ({ ...seg, dim: true })) : segs)
      const drawn = framed(body.map(dimmed), width, { color: COLOR[row.status], dim: isDone }, titleOf(row, isDone, dimmed))

      return (
        <Box marginLeft={depth * 2} key={row.id}>
          <Button key={openKey(row.id)} plain onPress={() => show($, row.id, 'back')}>
            {drawLines(drawn)}
          </Button>
        </Box>
      )
    }

    const detail = (row: AgentRow) => {
      const act = acts[row.id]
      const width = Math.max(MIN_CARD_WIDTH, columns)
      const inner = innerWidth(width)
      const groups = act === undefined ? [] : groupSteps(act)
      const turnCount = groups.filter(group => group.turn !== undefined).length
      const firstPrompt = groups.find(group => group.turn?.prompt)?.turn?.prompt
      const children = allLines.filter(line => line.row.parentId === row.id).map(line => line.row)
      const used = usageOf(act)
      const stuck = isEnded(row.status) ? undefined : stuckNote(act, row.startedAt ?? row.firstSeenAt, t)

      return (
        <Box flexDirection="column">
          {viewing !== row.id && banner}
          <Box flexDirection="row" gap={3}>
            <Button key="back" plain hotkey="b" autoFocus label="← back to list" onPress={() => show($, null, openKey(row.id))} />
            {viewing === row.id ? (
              <Button key="view" plain hotkey="v" label="main conversation" onPress={() => view($, undefined)} />
            ) : (
              <Button key="view" plain hotkey="v" label="view transcript" onPress={() => view($, row.id)} />
            )}
            {!isEnded(row.status) && (
              <Button
                key="stop"
                plain
                hotkey="s"
                label={asking === row.id ? 'press s again to stop' : 'stop agent'}
                onPress={() => stop($, row)}
              />
            )}
          </Box>
          {viewing === row.id && <Text color="warning">Showing this agent's transcript: what you type now goes to it.</Text>}
          <Box marginTop={1}>
            <Text>
              {drawLines(
                framed(
                  [
                    ...layoutRow([{ text: row.description || row.name || row.id, dim: true }], undefined, inner),
                    ...layoutRow(
                      [
                        { text: LABEL[row.status], color: COLOR[row.status] },
                        { text: ` · ${countsOf(act)}`, dim: true },
                      ],
                      undefined,
                      inner,
                    ),
                    ...(used === undefined
                      ? []
                      : layoutRow(
                          [
                            {
                              text: `${formatTokens(used.input + used.cacheRead + used.cacheWrite)} in (${formatTokens(used.cacheRead)} cached) · ${formatTokens(used.output)} out · ${used.model}`,
                              dim: true,
                            },
                          ],
                          undefined,
                          inner,
                        )),
                    ...(stuck === undefined ? [] : layoutRow([{ text: `⚠ ${stuck}`, color: 'warning' }], undefined, inner)),
                  ],
                  width,
                  { color: COLOR[row.status], dim: isEnded(row.status) },
                  titleOf(row, false),
                ),
              )}
            </Text>
          </Box>

          {!isEnded(row.status) && Input !== undefined && (
            <Box marginTop={1}>
              <Input
                key={msgKey(sends)}
                label="Message"
                placeholder="type, then enter to send to this agent"
                submitLabel="send"
                onSubmit={(text: string) => send($, row, text)}
              />
            </Box>
          )}

          {firstPrompt && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Prompt</Text>
              <Text dimColor>{firstPrompt}</Text>
            </Box>
          )}

          {act?.todos !== undefined && act.todos.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {taskHeading(act.todos)}
              {!isEnded(row.status) && workingLine(act.todos)}
              {taskItems(act.todos)}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Steps</Text>
            {groups.length === 0 && <Text dimColor>No tool calls yet.</Text>}
            {groups.map(group => {
              const turn = group.turn
              // A turn whose end went unheard ends with its agent.
              const state =
                turn === undefined
                  ? ''
                  : turn.reason !== undefined
                    ? ` · ${TURN_LABEL[turn.reason]} ${formatElapsed((turn.endedAt ?? turn.startedAt) - turn.startedAt)}`
                    : isEnded(row.status)
                      ? ` · ${LABEL[row.status]} ${formatElapsed(Math.max(0, (row.endedAt ?? t) - turn.startedAt))}`
                      : ` · running ${formatElapsed(Math.max(0, t - turn.startedAt))}`
              const heading =
                turn === undefined
                  ? 'Earlier steps'
                  : `Turn ${group.number ?? ''}${state}${turnCount > 1 && turn.prompt ? ` — ${turn.prompt}` : ''}`

              return (
                <Box flexDirection="column" key={`turn:${group.turnId ?? 'none'}`}>
                  <Text color="suggestion">
                    {heading}
                  </Text>
                  {group.steps.length === 0 && <Text dimColor>  no tool calls yet</Text>}
                  {group.steps.map(step => (
                    <Box flexDirection="column" key={step.id}>
                      <Box flexDirection="row">
                        <Box flexGrow={1} flexShrink={1}>
                          <Text dimColor={step.status === 'done'}>
                            {'  '}
                            <Text color={STEP_COLOR[step.status]}>
                              {step.status === 'running' ? frame : STEP_GLYPH[step.status]}
                            </Text>{' '}
                            {step.tool.padEnd(5)} <Text dimColor>{step.summary}</Text>
                          </Text>
                        </Box>
                        <Box flexShrink={0} marginLeft={1}>
                          <Text dimColor>{stepTime(step)}</Text>
                        </Box>
                      </Box>
                      {step.note && (
                        <Text color={STEP_COLOR[step.status]}>
                          {'    └ '}
                          {step.note}
                        </Text>
                      )}
                    </Box>
                  ))}
                </Box>
              )
            })}
          </Box>

          {children.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Subagents</Text>
              {children.map(child => {
                const right = `${LABEL[child.status]} ${timeOf(child)}`

                return (
                  <Button key={childKey(child.id)} plain onPress={() => show($, child.id, 'back')}>
                    <Text color={COLOR[child.status]}>{GLYPH[child.status]}</Text>
                    <Text>
                      {' '}
                      {child.type}{' '}
                    </Text>
                    <Text dimColor>{child.description || child.name || child.id}</Text>
                    <Text dimColor> {right}</Text>
                  </Button>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    const focused = shown === null ? undefined : rows[shown]
    if (focused !== undefined && focused.isListed) return detail(focused)

    const active = lines.filter(({ row }) => !isEnded(row.status)).length
    // The whole session at a glance: every listed agent's calls, errors and tokens.
    const listedActs = lines.map(({ row }) => acts[row.id]).filter((one): one is AgentActivity => one !== undefined)
    const tools = listedActs.reduce((n, one) => n + one.toolCount, 0)
    const errors = listedActs.reduce((n, one) => n + one.errorCount, 0)
    const tokens = listedActs.reduce((n, one) => n + totalTokens(usageOf(one) ?? EMPTY_USAGE), 0)
    const stuckCount = lines.filter(
      ({ row }) => !isEnded(row.status) && stuckNote(acts[row.id], row.startedAt ?? row.firstSeenAt, t) !== undefined,
    ).length
    const overview = [
      lines.length > 0 ? plural(tools, 'tool') : '',
      errors > 0 ? plural(errors, 'error') : '',
      tokens > 0 ? `${formatTokens(tokens)} tok` : '',
      cost !== null ? `session ${formatUsd(cost)}` : '',
    ]
      .filter(Boolean)
      .map(part => ` · ${part}`)
      .join('')

    // The main conversation's checklist, above its subagents, each item in
    // progress with its latest calls under it.
    const working = workingOf(checklist)
    const workingLog = working === undefined ? undefined : logs[working.id]
    const taskTools = checklist.reduce((n, item) => n + (logs[item.id]?.toolCount ?? 0), 0)
    const taskErrors = checklist.reduce((n, item) => n + (logs[item.id]?.errorCount ?? 0), 0)
    const taskGroup = (
      <Box flexDirection="column">
        {taskHeading(checklist, [taskTools > 0 ? plural(taskTools, 'tool') : '', taskErrors > 0 ? plural(taskErrors, 'error') : ''])}
        {workingLine(checklist, [
          working?.startedAt === undefined ? '' : formatElapsed(Math.max(0, t - working.startedAt)),
          workingLog === undefined || workingLog.toolCount === 0 ? '' : plural(workingLog.toolCount, 'tool'),
        ])}
        {isOpen(checklist) && taskItems(checklist, logs)}
      </Box>
    )

    // The account's rate-limit windows on one line at the pane's foot: the
    // name and the reset mark orange, the use bold, the time dim.
    const usageGroup =
      limits.length === 0 ? null : (
        <Text>
          {limits.map((limit, i) => {
            const { name, used, reset } = limitParts(limit, t)

            return (
              <Text key={`limit:${i}`}>
                <Text color={TITLE_COLOR}>{`${i > 0 ? '   ' : ''}${name}`}</Text>{' '}
                <Text bold>{used}</Text>
                {reset === '' ? null : (
                  <Text>
                    <Text dimColor> · </Text>
                    <Text color={TITLE_COLOR}>↻</Text>
                    <Text dimColor>{` ${reset}`}</Text>
                  </Text>
                )}
              </Text>
            )
          })}
        </Text>
      )

    // The shells: one terminal a lane, its command pinned on top, its log's
    // latest lines under it, as a terminal scrolls; the lane's next command
    // takes its place. A running card keeps its height as its log grows.
    const shownShells = visibleShells(shellRows, currentPrompt)
    const shellsRunning = shellRows.filter(one => one.status === 'running').length
    const shellTime = (one: ShellRow) => formatElapsed(Math.max(0, (one.endedAt ?? Math.max(t, one.startedAt)) - one.startedAt))
    const shellCard = (one: ShellRow) => {
      const isRunning = one.status === 'running'
      const width = Math.max(MIN_CARD_WIDTH, columns)
      const inner = innerWidth(width)
      const owner = one.agentId === undefined ? 'main' : (rows[one.agentId]?.type ?? 'agent')
      const end = isRunning
        ? ''
        : one.status === 'stopped'
          ? ' · stopped'
          : one.exitCode === undefined
            ? ''
            : ` · exit ${one.exitCode}`
      const keep = isRunning ? TAIL_LINES : DONE_TAIL_LINES
      const tail = one.tail.slice(-keep)
      const logRows: Line[] = [
        ...tail.map(text => [{ text: clip(text, inner), dim: true }]),
        ...(isRunning && tail.length === 0 ? [[{ text: 'waiting for output…', dim: true }]] : []),
      ]
      // Running, the log keeps its rows, filled from the top as it grows.
      const blank = isRunning ? Math.max(0, TAIL_LINES - logRows.length) : 0
      const body: Line[] = [
        [
          { text: '$ ', color: TITLE_COLOR, bold: true },
          { text: clip(commandLine(one.command), Math.max(0, inner - 2)), bold: isRunning },
        ],
        ...logRows,
        ...Array.from({ length: blank }, (): Line => []),
      ]
      const dimmed = (segs: Seg[]) => (isRunning ? segs : segs.map(seg => ({ ...seg, dim: true })))
      const title = {
        left: dimmed([
          { text: isRunning ? frame : SHELL_GLYPH[one.status], color: SHELL_COLOR[one.status] },
          { text: ` ${one.description ?? 'shell'}`, color: 'text', bold: isRunning },
        ]),
        right: dimmed([{ text: `${owner}${one.isBackground ? ' · bg' : ''} · ${shellTime(one)}${end}`, color: 'text' }]),
      }

      return (
        <Text key={`shell:${one.id}`}>
          {drawLines(framed(body.map(dimmed), width, { color: SHELL_COLOR[one.status], dim: !isRunning }, title))}
        </Text>
      )
    }
    const shellGroup =
      shellRows.length === 0 ? null : (
        <Box flexDirection="column">
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Shells</Text>: {shellsRunning} running · {shellRows.length - shellsRunning} done
            </Text>
          </Text>
          {shownShells.map(shellCard)}
        </Box>
      )

    // How full the session's context window is, as one bar the pane's width.
    const contextGroup = (() => {
      if (fill === null || fill.window <= 0) {
        return (
          <Text>
            <Text bold color={TITLE_COLOR}>
              Context
            </Text>
            <Text dimColor>: no reading yet</Text>
          </Text>
        )
      }
      const percent = Math.min(100, (fill.tokens / fill.window) * 100)
      const used = Math.round(percent)
      // One bar the pane's width, filled to the whole cell.
      const width = Math.max(1, columns)
      const full = Math.min(width, Math.round((percent / 100) * width))

      return (
        <Box flexDirection="column">
          {/* Headed as Tasks and Subagents are: the name bold in orange, the figures dim. */}
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Context</Text>: {percent < 1 && fill.tokens > 0 ? '<1' : used}%
            </Text>
            <Text dimColor>
              {' '}
              · {formatTokens(fill.tokens)} / {formatTokens(fill.window)} tok
            </Text>
          </Text>
          <Text>
            <Text color={percent >= 80 ? BAR_FULL_COLOR : BAR_COLOR}>{'█'.repeat(full)}</Text>
            <Text color="inactive">{'░'.repeat(width - full)}</Text>
          </Text>
        </Box>
      )
    })()
    // Under the context bar: how much of the latest request the cache served, and how long it stays warm.
    const cacheGroup = (() => {
      if (cache === null) return undefined
      const { hit, leftMs } = cacheParts(cache, t)

      return (
        <Box marginTop={1}>
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>Cache</Text>: {hit} hit
            </Text>
            <Text dimColor>{leftMs > 0 ? ` · ↻ ${formatElapsed(leftMs)}` : ' · expired'}</Text>
          </Text>
        </Box>
      )
    })()
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>

    // The header, centred: Claude's mascot in orange, the pane's name drawn
    // in letters as tall as it beside it; plain where the pane is too narrow.
    const header = (
      <Box flexDirection="row" justifyContent="center" width={Math.max(1, columns)}>
        <Box flexDirection="column">
          {MASCOT.map((line, i) => (
            <Text key={`mascot:${i}`} color={TITLE_COLOR}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          {columns >= HEADER_WIDTH ? (
            NAME_ART.map((line, i) => (
              <Text key={`name:${i}`} bold color={TITLE_COLOR}>
                {line}
              </Text>
            ))
          ) : (
            <Text bold color={TITLE_COLOR}>
              AGENT HUB
            </Text>
          )}
        </Box>
      </Box>
    )

    // Docked, the tree fills the pane's height so the usage sits at its foot.
    return (
      <Box flexDirection="column" minHeight={e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined}>
        <Box flexDirection="column" flexGrow={1}>
          {header}
          {rule}
          {contextGroup}
          {cacheGroup}
          {rule}
          {taskGroup}
          {/* A rule between the groups, the pane's full width. */}
          <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>
          <Text>
            <Text bold>
              <Text color={TITLE_COLOR}>{isAll ? 'All subagents' : 'Subagents'}</Text>: {active} running ·{' '}
              {lines.length - active} done
            </Text>
            <Text dimColor>{overview}</Text>
            {stuckCount > 0 && <Text color="warning"> · ⚠ {stuckCount} may be stuck</Text>}
          </Text>
          {(hidden > 0 || isAll || lines.length > 0) && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
              {(hidden > 0 || isAll) && (
                <Button
                  key="all"
                  plain
                  hotkey="a"
                  label={isAll ? 'latest only' : `all (+${hidden})`}
                  onPress={() => update($, showAll, all => !all)}
                />
              )}
              {lines.length > 0 && (
                <Button
                  key="expand"
                  plain
                  hotkey="e"
                  label={expanded ? 'compact' : 'expand'}
                  onPress={() => update($, isExpanded, isOn => !isOn)}
                />
              )}
            </Box>
          )}
          {banner}
          {lines.map(({ row, depth }) => card(row, depth))}
          {lines.length > 0 && (
            <Text dimColor>
              {e.props.isFocused ? 'tab: next card · enter: open · e: compact/expand · a: all agents' : 'ctrl+x tab: select a card'}
            </Text>
          )}
          {shellGroup === null ? null : rule}
          {shellGroup}
        </Box>
        {usageGroup === null ? null : rule}
        {usageGroup}
      </Box>
    )
  })
}
