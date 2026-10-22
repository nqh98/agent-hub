// The session's Bash commands as the Shells group draws them. The engine
// writes each command's output, while it runs, to `<tasks dir>/<id>.output`;
// a background command's file ends `[exited with code N]` when it exits, and
// a foreground one's is removed then, its output read from the call's result.

import type { ShellRow, ShellStatus } from '../types'
import { redact } from './steps'

export const MAX_SHELLS = 30
/** The log lines a running card draws. */
export const TAIL_LINES = 5
/** The log lines a finished card keeps drawn. */
export const DONE_TAIL_LINES = 2
/** The log lines a shell keeps, for its detail; its card draws the last few. */
export const KEEP_LINES = 40
/** A larger log is not read: one read copies the whole file. */
export const MAX_LOG_BYTES = 256 * 1024

const EXIT_TRAILER = /\n*\[exited with code (-?\d+)\]\s*$/
// CSI and OSC sequences, then any other control character but tab, newline, return.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/** A command's output file in the tasks dir; `a….output` are subagent transcripts. */
const SHELL_FILE = /^(b[a-z0-9]+)\.output$/

/** The latest lines of a log as a terminal shows them, and its exit code once it has one. */
export function readLog(text: string, keep = KEEP_LINES): { tail: string[]; exitCode?: number } {
  const exit = EXIT_TRAILER.exec(text)
  const body = exit === null ? text : text.slice(0, exit.index)
  const lines = body
    .replace(ANSI, '')
    .split('\n')
    // A carriage return redraws its line: a progress bar keeps only its last frame.
    .map(line => (line.split('\r').filter(part => part !== '').at(-1) ?? '').replace(CONTROL, '').replace(/\t/g, '  ').trimEnd())
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  const tail = lines.slice(-keep).map(redact)

  return exit === null ? { tail } : { tail, exitCode: Number(exit[1]) }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * What a foreground call printed, from its result: stdout then stderr, or the
 * text the model read when it failed (`Exit code 1` and the output).
 */
export function finalOutput(result: unknown, text: string | undefined): { output: string; exitCode?: number } {
  const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  const code = /^Exit code (-?\d+)/.exec(text ?? '')
  const exitCode = code === null ? undefined : Number(code[1])
  const printed = [str(record.stdout), str(record.stderr)].filter(part => part.trim() !== '').join('\n')
  if (printed !== '') return { output: printed, exitCode }

  return { output: (text ?? '').replace(/^Exit code -?\d+\n?/, ''), exitCode }
}

/** How a call ended, by its result. */
export function endStatus(ran: { deny?: string; isError?: boolean; result?: unknown }): ShellStatus {
  const record = typeof ran.result === 'object' && ran.result !== null ? (ran.result as Record<string, unknown>) : {}
  if (ran.deny !== undefined || record.interrupted === true) return 'stopped'

  return ran.isError === true ? 'failed' : 'done'
}

/** Adds a shell, dropping the oldest finished ones past MAX_SHELLS. */
export function startShell(shells: readonly ShellRow[], row: ShellRow): ShellRow[] {
  const all = [...shells.filter(one => one.id !== row.id), row]
  let extra = all.length - MAX_SHELLS

  return all.filter(one => (extra > 0 && one.status !== 'running' ? (extra -= 1) < 0 : true))
}

export function patchShell(shells: readonly ShellRow[], id: string, change: Partial<ShellRow>): ShellRow[] {
  return shells.some(one => one.id === id) ? shells.map(one => (one.id === id ? { ...one, ...change } : one)) : [...shells]
}

/** As patchShell, for a shell still running: a log read late never undoes its end. */
export function patchRunning(shells: readonly ShellRow[], id: string, change: Partial<ShellRow>): ShellRow[] {
  return shells.map(one => (one.id === id && one.status === 'running' ? { ...one, ...change } : one))
}

/**
 * A command moved to the background takes its id from the result; a file
 * guessed for another shell under that id is given back.
 */
export function toBackground(shells: readonly ShellRow[], id: string, taskId: string): ShellRow[] {
  return shells.map(one =>
    one.id === id
      ? { ...one, isBackground: true, taskId }
      : one.taskId === taskId
        ? { ...one, taskId: undefined, tail: [], size: undefined }
        : one,
  )
}

/**
 * The ids of the command files in a listing of the tasks dir, oldest first;
 * with `before`, only those last written before then.
 */
export function shellFiles(entries: readonly { name: string; kind: string; mtimeMs: number }[], before = Infinity): string[] {
  return entries
    .filter(entry => entry.kind === 'file' && entry.mtimeMs < before)
    .map(entry => ({ id: SHELL_FILE.exec(entry.name)?.[1], at: entry.mtimeMs }))
    .filter((entry): entry is { id: string; at: number } => entry.id !== undefined)
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.id)
}

/**
 * Gives each new command file to the oldest running foreground shell that has
 * none, in the order both began. The engine names no file for a foreground
 * call, so this is a guess: two commands started at once may swap logs.
 * Every id it is given is added to `seen`; a file nobody waits for (one from
 * before the mod loaded) is passed over for good.
 */
export function claimFiles(shells: readonly ShellRow[], files: readonly string[], seen: ReadonlySet<string>) {
  const taken = new Set([...seen, ...shells.flatMap(one => (one.taskId === undefined ? [] : [one.taskId]))])
  const fresh = files.filter(id => !taken.has(id))
  const waiting = shells.filter(one => one.status === 'running' && !one.isBackground && one.taskId === undefined)
  const given = new Map(waiting.slice(0, fresh.length).map((one, i) => [one.id, fresh[i]!]))
  const next = given.size === 0 ? [...shells] : shells.map(one => (given.has(one.id) ? { ...one, taskId: given.get(one.id) } : one))

  return { shells: next, seen: new Set([...seen, ...fresh]) }
}

/** Whose terminal a shell is drawn in: each background command its own, an agent's foreground ones one. */
export const laneOf = (row: ShellRow): string => (row.isBackground ? `bg:${row.id}` : `fg:${row.agentId ?? 'main'}`)

/**
 * The shells the group draws, oldest first: each lane's latest command, while
 * it runs, while it is the main conversation's, or while it is of the latest task.
 * A lane's next command takes its place.
 */
export function visibleShells(shells: readonly ShellRow[], task: number): ShellRow[] {
  const latest = new Map<string, ShellRow>()
  for (const row of shells) {
    const lane = laneOf(row)
    const was = latest.get(lane)
    if (was === undefined || row.startedAt >= was.startedAt) latest.set(lane, row)
  }

  return [...latest.values()]
    .filter(row => row.status === 'running' || laneOf(row) === 'fg:main' || row.task === task)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** One row cut to `width` columns, an ellipsis where it was cut. */
export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text

/** The command as its pinned row shows it: the first line, `…` when there are more. */
export function commandLine(command: string): string {
  const lines = command.split('\n').map(line => line.trim()).filter(line => line !== '')
  const first = redact(lines[0] ?? '')

  return lines.length > 1 ? `${first} …` : first
}

/** The command as its detail shows it: every line, trimmed, secrets masked. */
export const commandLines = (command: string): string[] =>
  command
    .split('\n')
    .map(line => redact(line.trimEnd()))
    .filter(line => line.trim() !== '')

/** A background command still running, with the id TaskStop takes. */
export const isStoppable = (row: ShellRow): boolean =>
  row.status === 'running' && row.isBackground && row.taskId !== undefined

/** Every shell of the session, newest first, as the detail lists them. */
export const shellHistory = (shells: readonly ShellRow[]): ShellRow[] =>
  [...shells].sort((a, b) => b.startedAt - a.startedAt)

/**
 * How long a running command may go without a log file before the pane says
 * it cannot follow it. The engine opens a command's file as it starts, so a
 * quiet command has one; none by now means the tasks dir was not found.
 */
export const OUTPUT_GRACE_MS = 10_000

/** What a running shell with no output yet reads as: waiting, or not followed live. */
export const waitingNote = (row: ShellRow, now: number): string =>
  row.taskId === undefined && now - row.startedAt >= OUTPUT_GRACE_MS
    ? 'live output unavailable · shown when it ends'
    : 'waiting for output…'
