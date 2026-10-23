import { describe, expect, test } from 'claude-code/testing'

import type { AgentActivity, AgentRow, ShellRow } from '../types'
import {
  commandsFor,
  fileContext,
  historyOf,
  isTerminalOnly,
  mentionsOf,
  parseHelperLine,
  parseSlash,
  projectPath,
  shareUrl,
  snapshot,
} from './remote'
import type { SnapshotInput } from './remote'

const agent = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id,
  type: 'Explore',
  description: `map ${id}`,
  isTeammate: false,
  task: 2,
  status: 'running',
  isListed: true,
  inList: true,
  firstSeenAt: 1000,
  startedAt: 1000,
  ...extra,
})

const shell = (id: string, extra: Partial<ShellRow> = {}): ShellRow => ({
  id,
  command: `npm run ${id}\nmore`,
  task: 2,
  status: 'running',
  taskId: `b${id}`,
  startedAt: 1000,
  tail: ['ready'],
  ...extra,
})

const empty: SnapshotInput = {
  now: 61_000,
  context: null,
  costUsd: null,
  rateLimits: [],
  tasks: [],
  agents: {},
  activity: {},
  shells: [],
  task: 2,
  busy: false,
  current: null,
  queued: [],
  result: null,
}

describe('remote', () => {
  test("the helper's lines read as what it started", () => {
    expect(parseHelperLine('PORT 51234')).toEqual({ kind: 'port', port: 51234 })
    expect(parseHelperLine('URL https://04ce61c2bce68a.lhr.life\n')).toEqual({ kind: 'url', url: 'https://04ce61c2bce68a.lhr.life' })
    expect(parseHelperLine('TOKEN abc_DEF-1')).toEqual({ kind: 'token', token: 'abc_DEF-1' })
    expect(parseHelperLine('ERROR tunnel closed: 255')).toEqual({ kind: 'error', text: 'tunnel closed: 255' })
    expect(parseHelperLine('Warning: Permanently added localhost.run')).toBeUndefined()
    expect(parseHelperLine('PORT abc')).toBeUndefined()
  })

  test("loca.lt's lines are no longer the helper's", () => {
    expect(parseHelperLine('PASSWORD 1.2.3.4')).toBeUndefined()
    expect(parseHelperLine('SUBDOMAIN agenthub-x')).toBeUndefined()
  })

  test('the link to share carries the token', () => {
    expect(shareUrl('https://04ce61c2bce68a.lhr.life', 't0k')).toBe('https://04ce61c2bce68a.lhr.life/?t=t0k')
    expect(shareUrl('https://04ce61c2bce68a.lhr.life/', 't0k')).toBe('https://04ce61c2bce68a.lhr.life/?t=t0k')
  })

  test('a prompt that starts with a slash is a command and its arguments', () => {
    expect(parseSlash('/compact keep the plan')).toEqual({ name: 'compact', args: 'keep the plan' })
    expect(parseSlash('  /cost  ')).toEqual({ name: 'cost', args: '' })
    expect(parseSlash('/review\nthe diff')).toEqual({ name: 'review', args: 'the diff' })
    expect(parseSlash('/superpowers:brainstorming a talk')).toEqual({ name: 'superpowers:brainstorming', args: 'a talk' })
    expect(parseSlash('plugin:skill-name x')).toBeUndefined()
    expect(parseSlash('fix /src/a.ts')).toBeUndefined()
    expect(parseSlash('/')).toBeUndefined()
    expect(parseSlash('/src/a.ts is broken')).toBeUndefined()
  })

  test('a command that draws a picker in the terminal does not run from the phone', () => {
    expect(isTerminalOnly('model')).toBe(true)
    expect(isTerminalOnly('resume')).toBe(true)
    expect(isTerminalOnly('agent-hub-remote')).toBe(true)
    expect(isTerminalOnly('compact')).toBe(false)
    expect(isTerminalOnly('cost')).toBe(false)
  })

  test('the typeahead lists the commands the phone can run, as the terminal orders them', () => {
    const listed = [
      { name: 'compact', description: 'Clear history, keep a summary', source: 'builtin' as const },
      { name: 'model', description: 'Set the model', source: 'builtin' as const },
      { name: 'review', description: 'Review a PR', source: 'plugin' as const, plugin: 'x' },
    ]

    expect(commandsFor(listed)).toEqual([
      { name: 'compact', description: 'Clear history, keep a summary' },
      { name: 'review', description: 'Review a PR' },
    ])
  })

  test('@ mentions are paths after a space or the start, trailing punctuation left out', () => {
    expect(mentionsOf('read @src/a.ts, then @docs/plan.md.')).toEqual(['src/a.ts', 'docs/plan.md'])
    expect(mentionsOf('@README.md')).toEqual(['README.md'])
    expect(mentionsOf('mail me at me@example.com')).toEqual([])
    expect(mentionsOf('twice @a.ts and @a.ts')).toEqual(['a.ts'])
    expect(mentionsOf('no mention @ here')).toEqual([])
  })

  test('a mentioned path resolves inside the project, never out of it', () => {
    expect(projectPath('/p/repo', 'src/a.ts')).toBe('/p/repo/src/a.ts')
    expect(projectPath('/p/repo/', './src/../lib/b.ts')).toBe('/p/repo/lib/b.ts')
    expect(projectPath('/p/repo', '/p/repo/c.ts')).toBe('/p/repo/c.ts')
    expect(projectPath('/p/repo', '../secret.txt')).toBeUndefined()
    expect(projectPath('/p/repo', '/etc/passwd')).toBeUndefined()
    expect(projectPath('/p/repo', '/p/repository/x')).toBeUndefined()
  })

  test("a file's context block names it and fences its text", () => {
    expect(fileContext('src/a.ts', 'const a = 1\n')).toBe('Contents of @src/a.ts:\n```\nconst a = 1\n```')
  })

  test('an idle session with nothing read yet is an empty view', () => {
    const view = snapshot(empty)

    expect(view.context).toBeNull()
    expect(view.cost).toBeNull()
    expect(view.limits).toEqual([])
    expect(view.tasks).toEqual([])
    expect(view.agents).toEqual([])
    expect(view.shells).toEqual([])
    expect(view.busy).toBe(false)
  })

  test('the context fill reads as a percent of the window', () => {
    const view = snapshot({ ...empty, context: { tokens: 230_000, window: 1_000_000 }, costUsd: 0.4231 })

    expect(view.context).toEqual({ percent: 23, used: '230k', window: '1.0M' })
    expect(view.cost).toBe('$0.42')
  })

  test('the checklist keeps each item and names the one in progress', () => {
    const view = snapshot({
      ...empty,
      tasks: [
        { id: '1', text: 'Read the spec', status: 'completed' },
        { id: '2', text: 'Write the parser', status: 'in_progress', active: 'Writing the parser' },
        { id: '3', text: 'Add tests', status: 'pending' },
      ],
    })

    expect(view.tasks).toEqual([
      { text: 'Read the spec', status: 'completed' },
      { text: 'Write the parser', status: 'in_progress' },
      { text: 'Add tests', status: 'pending' },
    ])
    expect(view.working).toBe('Writing the parser')
  })

  test("the latest prompt's agents show as a tree with time, tokens and latest step", () => {
    const acts: Record<string, AgentActivity> = {
      a: {
        turns: [],
        steps: [{ id: 's1', tool: 'Read', summary: 'src/a.ts', status: 'running', startedAt: 2000 }],
        toolCount: 1,
        errorCount: 0,
        usage: { input: 10_000, output: 2_000, cacheRead: 1_000, cacheWrite: 0, model: 'opus' },
      },
    }
    const view = snapshot({
      ...empty,
      agents: {
        a: agent('a'),
        b: agent('b', { parentId: 'a', status: 'completed', endedAt: 31_000 }),
        old: agent('old', { task: 1, status: 'completed', endedAt: 5000 }),
      },
      activity: acts,
    })

    expect(view.agents).toEqual([
      { id: 'a', depth: 0, type: 'Explore', description: 'map a', status: 'running', elapsed: '1:00', tokens: '13k', step: 'Read src/a.ts', tools: 1 },
      { id: 'b', depth: 1, type: 'Explore', description: 'map b', status: 'completed', elapsed: '0:30', tools: 0 },
    ])
  })

  test("shells show their command's first line, status and latest output", () => {
    const view = snapshot({ ...empty, shells: [shell('dev'), shell('old', { task: 1, status: 'done', exitCode: 0 })] })

    expect(view.shells).toEqual([{ id: 'dev', command: 'npm run dev …', status: 'running', tail: ['ready'] }])
  })

  test('the usage limits read as name, percent used and reset', () => {
    const view = snapshot({ ...empty, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] })

    expect(view.limits).toEqual([{ name: '5h', used: '40%', reset: '' }])
  })

  test('a turn running names its prompt and when it started; idle, none', () => {
    const current = { prompt: 'fix the parser', startedAt: 50_000 }

    expect(snapshot({ ...empty, busy: true, current }).current).toEqual(current)
    expect(snapshot({ ...empty, busy: false, current }).current).toBeNull()
  })

  test('the turn state, waiting prompts and last answer pass through', () => {
    const result = { prompt: 'fix it', text: 'Done.', reason: 'answer' as const, at: 60_000 }
    const view = snapshot({ ...empty, busy: true, queued: ['next one'], result })

    expect(view.busy).toBe(true)
    expect(view.queued).toEqual(['next one'])
    expect(view.result).toEqual(result)
  })


  test('the history pairs each prompt with the text the assistant wrote for it', () => {
    const said = (role: 'user' | 'assistant', text: string, extra: object = {}) => ({ role, text, toolUses: [], ...extra })
    const turns = historyOf([
      said('user', 'fix the parser'),
      said('assistant', 'Reading it.'),
      said('user', '', { toolResults: [{ tool_use_id: 'x', text: 'ok', isError: false }] }),
      said('assistant', ''),
      said('assistant', 'Fixed: **empty input** is handled.'),
      said('user', 'thanks'),
    ])

    expect(turns).toEqual([
      { prompt: 'fix the parser', answer: 'Reading it.\n\nFixed: **empty input** is handled.' },
      { prompt: 'thanks', answer: '' },
    ])
  })

  test("the history reads a slash command, its output and a shell command as the terminal showed them", () => {
    const user = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
    const turns = historyOf([
      user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>'),
      user('<local-command-stdout>\u001b[2mCompacted\u001b[22m</local-command-stdout>'),
      user('<local-command-caveat>Caveat: run directly.</local-command-caveat>'),
      user('<bash-input>git status</bash-input>'),
      user('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'),
    ])

    expect(turns).toEqual([
      { prompt: '/compact keep the plan', answer: 'Compacted' },
      { prompt: '! git status', answer: '```\nclean\n```' },
    ])
  })

  test('reminders the engine adds are not part of a prompt, and a message of nothing else starts no turn', () => {
    const user = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
    const turns = historyOf([
      user('<system-reminder>be brief</system-reminder>'),
      user('explain @a.ts\n<system-reminder>files changed</system-reminder>'),
      { role: 'assistant' as const, text: 'It parses.', toolUses: [] },
    ])

    expect(turns).toEqual([{ prompt: 'explain @a.ts', answer: 'It parses.' }])
  })

  test('the history keeps the latest turns, a long answer kept by its end', () => {
    const many = Array.from({ length: 40 }, (_, i) => [
      { role: 'user' as const, text: `q${i}`, toolUses: [] },
      { role: 'assistant' as const, text: `a${i}`, toolUses: [] },
    ]).flat()
    const turns = historyOf(many, { turns: 3 })

    expect(turns.map(turn => turn.prompt)).toEqual(['q37', 'q38', 'q39'])

    const long = historyOf([{ role: 'user', text: 'q', toolUses: [] }, { role: 'assistant', text: `start ${'x'.repeat(50)} end`, toolUses: [] }], { chars: 10 })
    expect(long[0]!.answer).toBe('…xxxxxx end')
  })
})

