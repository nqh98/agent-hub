// Remote control: the pane's state as a plain view a phone's browser draws,
// the lines the helper (remote/server.mjs) writes as it starts, and what the
// phone's prompts need before they run: their slash command, their @ files.
// localhost.run's tunnel puts no reminder page in front of a browser.

import type { CommandInfo } from 'claude-code'

import type { AgentActivity, AgentRow, AgentRowStatus, RateLimitRow, ShellRow, ShellStatus, TodoItem, TodoStatus, TurnEndReason } from '../types'
import { formatTokens, formatUsd, limitParts, totalTokens, usageOf } from './plan'
import { elapsedMs, formatElapsed, latestTask, visibleTree } from './roster'
import { commandLine, visibleShells } from './shells'

/** What one line of the helper's stdout says; anything else (ssh's chatter) is not one. */
export type HelperEvent =
  | { kind: 'port'; port: number }
  | { kind: 'url'; url: string }
  | { kind: 'token'; token: string }
  | { kind: 'error'; text: string }

export function parseHelperLine(line: string): HelperEvent | undefined {
  const match = /^([A-Z]+) (.+)$/.exec(line.trim())
  if (match === null) return undefined
  const [, word, rest] = match as unknown as [string, string, string]
  switch (word) {
    case 'PORT': {
      const port = Number(rest)

      return Number.isInteger(port) && port > 0 ? { kind: 'port', port } : undefined
    }
    case 'URL':
      return { kind: 'url', url: rest }
    case 'TOKEN':
      return { kind: 'token', token: rest }
    case 'ERROR':
      return { kind: 'error', text: rest }
    default:
      return undefined
  }
}

/** The link the phone opens: the tunnel's address with the token that lets it in. */
export const shareUrl = (url: string, token: string): string => `${url.replace(/\/+$/, '')}/?t=${encodeURIComponent(token)}`

/**
 * `/name args` as the phone typed it: a command's name is one word (a
 * plugin's `plugin:name` too) right after the slash, so a path such as
 * `/src/a.ts` is a prompt, not a command.
 */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return undefined

  return { name: match[1]!, args: (match[2] ?? '').trim() }
}

// Commands that draw a picker or a dialog in the terminal, or would end the
// remote itself: from the phone they would wait on keys no one presses there.
const TERMINAL_ONLY = new Set([
  'add-dir', 'agent-hub', 'agent-hub-remote', 'agents', 'allowed-tools', 'bashes', 'config', 'doctor', 'exit',
  'export', 'help', 'hooks', 'ide', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model',
  'output-style', 'permissions', 'plugin', 'plugins', 'privacy-settings', 'quit', 'resume', 'rewind',
  'settings', 'status', 'statusline', 'tasks', 'terminal-setup', 'theme', 'upgrade', 'vim',
])

export const isTerminalOnly = (name: string): boolean => TERMINAL_ONLY.has(name)

/** The commands the phone's typeahead offers: those it can run, in the terminal's order. */
export const commandsFor = (list: readonly CommandInfo[]): { name: string; description: string }[] =>
  list.filter(one => !isTerminalOnly(one.name)).map(({ name, description }) => ({ name, description }))

/**
 * The paths a prompt mentions with `@`, each once: an `@` at the start or
 * after a space (an address's is neither), its trailing punctuation left out.
 */
export function mentionsOf(text: string): string[] {
  const found = [...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map(match => match[1]!.replace(/[.,;:!?)\]}'"]+$/, ''))

  return [...new Set(found.filter(path => path !== ''))]
}

/** A mentioned path made absolute under the project's root; undefined when it leads out of it. */
export function projectPath(root: string, path: string): string | undefined {
  const base = root.replace(/\/+$/, '')
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) return undefined
  }
  const resolved = `/${parts.join('/')}`

  return resolved === base || resolved.startsWith(`${base}/`) ? resolved : undefined
}

/** A mentioned file as the model reads it beside the prompt, as Claude Code expands `@` for a typed one. */
export const fileContext = (path: string, text: string): string =>
  `Contents of @${path}:\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``

/** One turn of the main conversation as the phone's history shows it: what was asked, what was written back. */
export type HistoryTurn = { prompt: string; answer: string }

/** A transcript row as far as the history reads it (SessionMessage). */
type HistoryMessage = { role: 'user' | 'assistant'; text: string; toolUses?: readonly unknown[]; toolResults?: readonly unknown[] }

// The longest prompt shown: a compaction's summary arrives as one.
const PROMPT_CHARS = 4_000
const ANSI = /\u001b\[[0-9;]*m/g
const tagged = (text: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]

/**
 * The main conversation's latest turns, from its transcript: each prompt (a
 * slash command and a shell command as the terminal showed them) with the
 * assistant's text under it, tool calls left out. The engine's reminders are
 * no part of a prompt; a long answer is kept by its end, where it concludes.
 */
export function historyOf(messages: readonly HistoryMessage[], { turns = 30, chars = 20_000 } = {}): HistoryTurn[] {
  const found: { prompt: string; parts: string[] }[] = []
  const answer = (part: string) => {
    if (part.trim() !== '') found.at(-1)?.parts.push(part.trim())
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      answer(message.text)
      continue
    }
    // A tool's result rides a user message; it is no prompt.
    if ((message.toolResults?.length ?? 0) > 0) continue
    const text = message.text.replace(/<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g, '')
    const command = tagged(text, 'command-name')
    const shell = tagged(text, 'bash-input')
    const output = tagged(text, 'local-command-stdout')
    const shellOutput = [tagged(text, 'bash-stdout'), tagged(text, 'bash-stderr')]
    if (command !== undefined) {
      const args = tagged(text, 'command-args')?.trim()
      found.push({ prompt: args ? `${command.trim()} ${args}` : command.trim(), parts: [] })
    } else if (shell !== undefined) {
      found.push({ prompt: `! ${shell.trim()}`, parts: [] })
    } else if (output !== undefined) {
      answer(output.replace(ANSI, ''))
    } else if (shellOutput.some(part => part !== undefined)) {
      const shown = shellOutput
        .map(part => (part ?? '').replace(ANSI, '').trim())
        .filter(Boolean)
        .join('\n')
      if (shown !== '') answer(`\`\`\`\n${shown}\n\`\`\``)
    } else if (text.trim() !== '') {
      const prompt = text.trim()
      found.push({ prompt: prompt.length > PROMPT_CHARS ? `${prompt.slice(0, PROMPT_CHARS)}…` : prompt, parts: [] })
    }
  }

  return found.slice(-turns).map(({ prompt, parts }) => {
    const text = parts.join('\n\n')

    return { prompt, answer: text.length > chars ? `…${text.slice(-chars)}` : text }
  })
}

/** The turn the main conversation is running: what the phone pins while it waits. */
export type RemoteTurn = { prompt: string; startedAt: number }

/** The main conversation's latest answer, kept for the phone to review. */
export type RemoteResult = { prompt: string; text: string; reason: TurnEndReason; at: number }

export type SnapshotInput = {
  now: number
  context: { tokens: number; window: number } | null
  costUsd: number | null
  rateLimits: readonly RateLimitRow[]
  tasks: readonly TodoItem[]
  agents: Record<string, AgentRow>
  activity: Record<string, AgentActivity>
  shells: readonly ShellRow[]
  /** The person's prompt count: agents and shells keep to the latest one, as the pane does. */
  task: number
  /** The main conversation is in a turn. */
  busy: boolean
  /** The prompt of the main conversation's latest turn and when it started (epoch ms). */
  current: RemoteTurn | null
  /** Prompts the phone sent that have not started a turn yet. */
  queued: readonly string[]
  result: RemoteResult | null
}

export type RemoteAgent = {
  id: string
  depth: number
  type: string
  description: string
  status: AgentRowStatus
  elapsed: string
  tokens?: string
  /** The latest call: its tool and what it ran on. */
  step?: string
  tools: number
}

export type RemoteView = {
  context: { percent: number; used: string; window: string } | null
  cost: string | null
  limits: { name: string; used: string; reset: string }[]
  tasks: { text: string; status: TodoStatus }[]
  working?: string
  agents: RemoteAgent[]
  shells: { id: string; command: string; status: ShellStatus; tail: string[] }[]
  busy: boolean
  /** The turn running now; null while idle. */
  current: RemoteTurn | null
  queued: string[]
  result: RemoteResult | null
}

export function snapshot(input: SnapshotInput): RemoteView {
  const { now, context } = input
  const working = input.tasks.find(item => item.status === 'in_progress')
  const agents = visibleTree(latestTask(input.agents, input.task)).map(({ row, depth }): RemoteAgent => {
    const act = input.activity[row.id]
    const usage = usageOf(act)
    const last = act?.steps.at(-1)

    return {
      id: row.id,
      depth,
      type: row.type,
      description: row.description || row.name || row.id,
      status: row.status,
      elapsed: formatElapsed(elapsedMs(row, now)),
      ...(usage === undefined ? {} : { tokens: formatTokens(totalTokens(usage)) }),
      ...(last === undefined ? {} : { step: `${last.tool} ${last.summary}`.trim() }),
      tools: act?.toolCount ?? 0,
    }
  })

  return {
    context:
      context === null
        ? null
        : {
            percent: context.window > 0 ? Math.round((context.tokens / context.window) * 100) : 0,
            used: formatTokens(context.tokens),
            window: formatTokens(context.window),
          },
    cost: input.costUsd === null ? null : formatUsd(input.costUsd),
    limits: input.rateLimits.map(limit => limitParts(limit, now)),
    tasks: input.tasks.map(item => ({ text: item.text, status: item.status })),
    ...(working === undefined ? {} : { working: working.active ?? working.text }),
    agents,
    shells: visibleShells(input.shells, input.task).map(one => ({
      id: one.id,
      command: commandLine(one.command),
      status: one.status,
      tail: one.tail,
    })),
    busy: input.busy,
    current: input.busy ? input.current : null,
    queued: [...input.queued],
    result: input.result,
  }
}
