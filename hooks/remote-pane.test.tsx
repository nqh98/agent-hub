import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Agent Hub',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

test('remote control on shows the link and its QR code, which folds away', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('session.measure', (_$, e) => ({ changed: e.changed ?? [] }))
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp' })
  mock.session(on)
  on('session.id', () => ({ value: 'abcdef123456' }))
  on('ui.open', () => ({ value: undefined }) as never)
  // What the mod's sync reaches: the helper's socket, the commands, the project's files.
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: '{"prompts":[]}' } }))
  on('command.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  // The helper, faked: it says its token, port and address, then runs until the test ends.
  let end = () => {}
  const ended = new Promise<void>(resolve => (end = resolve))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'TOKEN t0k\nPORT 51234\nURL https://04ce61c2bce68a.lhr.life\n' }
    await ended

    return { value: { code: 0 } }
  } as never)
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
  await $.command.run({ command: 'agent-hub-remote', args: '' } as never)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'https://04ce61c2bce68a.lhr.life/?t=t0k' })).toBeDefined()
  const code = /^█{10,}\n[█▀▄ ]+\n/
  expect(await ui.find({ type: 'Text', text: code })).toBeDefined()

  await ui.press({ key: 'remote-qr' })
  expect(await ui.find({ type: 'Text', text: code })).toBeUndefined()
  expect(await ui.find({ text: 'show QR' })).toBeDefined()
  expect(await ui.find({ text: 'hide QR' })).toBeUndefined()

  end()
  await ui.unmount()
})
