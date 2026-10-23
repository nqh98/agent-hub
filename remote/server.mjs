// Agent Hub remote: the helper the mod starts with `node server.mjs`.
//
// Two listeners. A Unix socket (AGENT_HUB_SOCKET) for the mod alone: it posts
// the pane's view to /sync and takes back the prompts the phone sent. A TCP
// port on 127.0.0.1 for the tunnel: the page and its API, each request let in
// only with the token. Nothing the mod uses is on the port, which the tunnel
// puts on the internet.
//
// The tunnel is localhost.run, over the ssh every Mac has: no install, no
// account, and no reminder page in front of a browser. Its address is new at
// each start, and may change while it runs; each new one is said again.
//
// What it starts, it says on stdout, one line each: TOKEN, PORT, URL, ERROR.
// It exits when the mod stops syncing (the session ended or the mod
// reloaded), taking the tunnel with it.

import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOCKET = process.env.AGENT_HUB_SOCKET
const TOKEN = process.env.AGENT_HUB_TOKEN || randomBytes(18).toString('base64url')
const TUNNEL = process.env.AGENT_HUB_TUNNEL !== 'none'
// The mod syncs every second; this long without one, it is gone.
const IDLE_MS = 15_000
const MAX_PROMPT = 20_000
const MAX_INBOX = 20
const TUNNEL_RETRIES = 5
// The address localhost.run gives a tunnel, among the lines of its banner.
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.lhr\.life/i

const say = (word, text) => process.stdout.write(`${word} ${text}\n`)

if (!SOCKET) {
  say('ERROR', 'AGENT_HUB_SOCKET is not set')
  process.exit(2)
}

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
let view = null
let viewAt = 0
// What the phone's typeahead lists: the commands and the project's files, as the mod last sent them.
let catalog = { commands: [], files: [] }
let inbox = []
// The main conversation's latest turns, as the mod last sent them, and when.
let history = { turns: [], at: 0 }
let lastSync = Date.now()
let tunnel = null
let tunnelUrl = ''
let tries = 0
let closing = false

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const isToken = given => {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(TOKEN)

  return a.length === b.length && timingSafeEqual(a, b)
}

// The mod's side.
const local = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/sync') {
    try {
      const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}')
      lastSync = Date.now()
      if (body.view !== undefined) {
        view = body.view
        viewAt = lastSync
      }
      if (body.catalog) catalog = body.catalog
      if (Array.isArray(body.history)) history = { turns: body.history, at: lastSync }
      const prompts = inbox
      inbox = []
      send(res, 200, { prompts })
    } catch (error) {
      send(res, 400, { error: String(error.message ?? error) })
    }

    return
  }
  if (req.method === 'POST' && req.url === '/quit') {
    send(res, 200, { ok: true })
    setTimeout(() => shutdown(0), 50)

    return
  }
  send(res, 404, { error: 'not found' })
})

// The phone's side, through the tunnel.
const pub = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!isToken(url.searchParams.get('t'))) {
    send(res, 403, 'Agent Hub: this link needs its token.', 'text/plain; charset=utf-8')

    return
  }
  if (req.method === 'GET' && url.pathname === '/') {
    send(res, 200, page, 'text/html; charset=utf-8')
  } else if (req.method === 'GET' && url.pathname === '/api/catalog') {
    send(res, 200, catalog)
  } else if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, { view, at: viewAt, now: Date.now(), inbox: inbox.length, historyAt: history.at })
  } else if (req.method === 'GET' && url.pathname === '/api/history') {
    send(res, 200, history)
  } else if (req.method === 'POST' && url.pathname === '/api/prompt') {
    try {
      const { text } = JSON.parse((await readBody(req, MAX_PROMPT * 4)) || '{}')
      const prompt = String(text ?? '').trim()
      if (prompt === '' || prompt.length > MAX_PROMPT) return send(res, 400, { error: 'empty or too long' })
      if (inbox.length >= MAX_INBOX) return send(res, 429, { error: 'too many waiting prompts' })
      inbox.push(prompt)
      send(res, 200, { ok: true })
    } catch (error) {
      send(res, 400, { error: String(error.message ?? error) })
    }
  } else {
    send(res, 404, { error: 'not found' })
  }
})

function startTunnel(port) {
  // Its own process group, so the whole of it goes on shutdown. BatchMode:
  // never wait on a prompt no one sees; ExitOnForwardFailure: a refused
  // forward is an exit, retried, not a tunnel that silently carries nothing.
  tunnel = spawn(
    'ssh',
    [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const read = chunk => {
    const found = TUNNEL_URL.exec(String(chunk))
    if (found && found[0] !== tunnelUrl) {
      tries = 0
      tunnelUrl = found[0]
      say('URL', tunnelUrl)
    }
  }
  tunnel.stdout.on('data', read)
  tunnel.stderr.on('data', read)
  tunnel.on('exit', code => {
    tunnel = null
    if (closing) return
    tries += 1
    if (tries > TUNNEL_RETRIES) {
      say('ERROR', `the tunnel stopped (exit ${code}) and did not come back`)
      shutdown(1)

      return
    }
    say('ERROR', `the tunnel stopped (exit ${code}); retrying`)
    setTimeout(() => startTunnel(port), 3000)
  })
}

const killTunnel = () => {
  if (!tunnel?.pid) return
  try {
    process.kill(-tunnel.pid, 'SIGTERM')
  } catch {}
}

function shutdown(code = 0) {
  if (closing) return
  closing = true
  killTunnel()
  rmSync(SOCKET, { force: true })
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))
process.on('exit', killTunnel)

setInterval(() => {
  if (Date.now() - lastSync > IDLE_MS) {
    say('ERROR', `no sync from Agent Hub for ${IDLE_MS / 1000}s; closing`)
    shutdown(0)
  }
}, 2000).unref()

say('TOKEN', TOKEN)
rmSync(SOCKET, { force: true })
local.listen(SOCKET, () => {
  pub.listen(0, '127.0.0.1', () => {
    const { port } = pub.address()
    say('PORT', port)
    if (TUNNEL) startTunnel(port)
  })
})
