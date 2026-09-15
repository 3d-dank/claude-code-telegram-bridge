#!/usr/bin/env node
/**
 * claude-code-telegram-bridge — bridges a Telegram chat to the Claude Code CLI.
 *
 * Each allowed Telegram message is handed to `claude -p` (headless) running in
 * WORKSPACE, and the reply is sent back. Session continuity per chat via
 * `--resume`. Designed to run under systemd (always-on + auto-restart).
 *
 * Config comes from environment (see config.env.example):
 *   TELEGRAM_BOT_TOKEN   - your bot's token from @BotFather
 *   ALLOWED_CHAT_IDS     - comma-separated chat ids allowed to use it
 *   WORKSPACE            - cwd for claude (default: process.cwd())
 *   PERMISSION_MODE      - claude --permission-mode (default 'plan' = read/analyze, no changes)
 *   CLAUDE_MODEL         - optional --model override
 *   CLAUDE_BIN           - absolute path to the claude binary (systemd's PATH is minimal)
 *   MAX_SESSION_BYTES    - session transcript size that triggers a rollover (default 750000)
 *   SUMMARY_MODEL        - cheap model used to write the rollover handoff note
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync, openAsBlob } from 'node:fs'
import { resolve, basename, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import net from 'node:net'
import dns from 'node:dns'

const HERE = dirname(fileURLToPath(import.meta.url))

// Some hosts have a global IPv6 address but no working IPv6 default route, while
// api.telegram.org resolves to both A and AAAA records. Node's "Happy Eyeballs"
// (autoSelectFamily) can attempt the IPv6 address first; with the route black-holed
// the socket hangs until ETIMEDOUT, surfacing as an endless "poll error: fetch failed".
// Force IPv4 and disable family autoselection so fetch uses the working v4 path.
// Harmless if your host's IPv6 works fine.
dns.setDefaultResultOrder('ipv4first')
net.setDefaultAutoSelectFamily?.(false)

// `claude -p --output-format json` exits non-zero on some hard stops (e.g. a safety-filter
// refusal) but still writes a full stats JSON blob to stdout with no human-readable message
// up front — the useful bit, if any (`result`/`error`), sits after a wall of usage/cost
// fields. Blindly slicing the first 1500 chars (as the old fallback below does) hands the
// user token-accounting noise and cuts off before the actual reason. Parse first; only fall
// back to a raw slice when there's truly nothing structured to explain the failure.
function friendlyChildError(raw) {
  let j
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== 'object') return null
  if (typeof j.result === 'string' && j.result.trim()) return j.result.trim()
  if (typeof j.error === 'string' && j.error.trim()) return j.error.trim()
  if (j.stop_reason === 'refusal') {
    return "Claude's safety filter declined to continue this response. This is often a false positive on legitimate content — try rephrasing, or send /reset to start a clean session."
  }
  if (j.terminal_reason && j.terminal_reason !== 'success') {
    return `Claude Code stopped early (${j.terminal_reason}). Try again, or send /reset to start a clean session.`
  }
  return null
}

// Run a command with stdin CLOSED (claude -p otherwise waits on an empty stdin pipe
// when launched by systemd). Resolves with stdout; rejects with stderr on non-zero exit.
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')) }, opts.timeoutMs || 1000 * 60 * 30)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) { resolve(out); return }
      const raw = err || out || `exit ${code}`
      console.error(`[bridge] child exit ${code}: ${raw.slice(0, 2000)}`)
      reject(new Error(friendlyChildError(raw) || raw.slice(0, 1500)))
    })
  })
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean))
const WORKSPACE = process.env.WORKSPACE || process.cwd()
const PERMISSION_MODE = process.env.PERMISSION_MODE || 'plan'
const MODEL = process.env.CLAUDE_MODEL || ''
// Absolute path to the claude binary — systemd's PATH is minimal and won't find it.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const SESS_DIR = process.env.SESSION_DIR || resolve(HERE, 'sessions')

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1) }
if (ALLOWED.size === 0) { console.error('ALLOWED_CHAT_IDS not set — refusing to run open to the world'); process.exit(1) }
if (!existsSync(SESS_DIR)) mkdirSync(SESS_DIR, { recursive: true })

const API = `https://api.telegram.org/bot${TOKEN}`
const sessFile = id => `${SESS_DIR}/${String(id).replace(/[^\w-]/g, '_')}.txt`
const getSession = id => { try { return readFileSync(sessFile(id), 'utf8').trim() || null } catch { return null } }
const setSession = (id, sid) => { try { writeFileSync(sessFile(id), sid) } catch {} }

// Session-size guard. `claude -p --resume` reloads the ENTIRE session transcript as context
// on every message, so an ever-growing session means an ever-growing per-message token bill
// (a multi-MB session can cost several dollars per message and start hitting 429s). When a
// chat's transcript grows past MAX_SESSION_BYTES we drop its session id so the NEXT message
// starts a fresh, cheap session. The check runs after a reply (see maybeRollover), so sessions
// overshoot this by whatever the final turn added. Tune via MAX_SESSION_BYTES.
const MAX_SESSION_BYTES = Number(process.env.MAX_SESSION_BYTES || 750_000)
const HOME = process.env.HOME || os.homedir()
// Claude Code stores transcripts at ~/.claude/projects/<cwd, non-alphanumerics→'-'>/<sid>.jsonl
const transcriptPath = sid => `${HOME}/.claude/projects/${WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-')}/${sid}.jsonl`
const sessionBytes = sid => { try { return statSync(transcriptPath(sid)).size } catch { return 0 } }

// Carry-over summary so a size-triggered reset doesn't make users re-teach context. At rollover
// we ask the oversized session to summarize itself, stash the note here, then seed it into the
// first message of the fresh session. SUMMARY_MODEL (a cheaper model) does the read-only
// summarizing, keeping the once-per-rollover cost low.
const summaryFile = id => `${SESS_DIR}/${String(id).replace(/[^\w-]/g, '_')}.summary.txt`
const getSummary = id => { try { return readFileSync(summaryFile(id), 'utf8').trim() || null } catch { return null } }
const setSummary = (id, s) => { try { writeFileSync(summaryFile(id), s || '') } catch {} }
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || ''

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}

// Environment handed to the child Claude. The chat id MUST be propagated: the agent
// is otherwise never told which chat it is serving, and when asked to send a file it
// has to guess a target — and a wrong guess means a file goes to the wrong chat, which
// in a group-chat setting can mean the wrong PEOPLE. Chat identity comes from the
// incoming message — the same source the reply path uses — never from ALLOWED_CHAT_IDS
// (an allowlist, wrong as soon as there is more than one allowed chat).
// The bot token is deliberately withheld from the child: the agent cannot send to
// Telegram directly, so it cannot send to the wrong chat, and a prompt injection in
// an incoming message has no outbound channel to exfiltrate through. To deliver a
// file the agent emits a [[send-file: …]] marker and the bridge does the upload.
// If you run another CLI/tool in the same environment that carries its OWN messaging
// credentials (a different bot, a different Slack app, etc.), withholding this token
// alone does not close that egress path — shim that tool out of PATH too. See
// shims/example-shim.sh for the pattern.
const SHIM_DIR = process.env.SHIM_DIR || resolve(HERE, 'shims')

export function childEnv(chatId) {
  const env = { ...process.env, TELEGRAM_CHAT_ID: String(chatId) }
  delete env.TELEGRAM_BOT_TOKEN
  env.PATH = `${SHIM_DIR}:${process.env.PATH || ''}`
  return env
}

// Layer 2: a standing directive prepended to EVERY prompt. A memory file or a one-off
// instruction is lost at session rollover; this is re-injected each turn, so it cannot
// be summarized away or displaced by stale conversation history.
export const DELIVERY_DIRECTIVE = [
  '[Bridge policy — always applies, overrides any conflicting note or memory]',
  'You have NO Telegram credentials. Never send Telegram messages or files yourself.',
  'To attach a file, put this on its own line: [[send-file: <path relative to workspace> | <caption>]]',
  'The bridge uploads it to the chat this request came from. Never curl api.telegram.org,',
  'and never use a hardcoded chat id — they go to the wrong chat.',
].join('\n')

// Layer 1: strip delivery mechanics out of the rollover handoff note. The note is the
// first thing a fresh session reads, so a line like "sent the report to chat -100374…"
// re-teaches the wrong target on every rollover. Scrub ids and any command that names
// an egress path.
export function scrubSummary(text) {
  if (!text) return text
  return String(text)
    .split('\n')
    .filter(l => !/api\.telegram\.org|sendDocument/i.test(l))
    .join('\n')
    .replace(/-?\d{10,}/g, '<chat id removed — the bridge handles delivery>')
    .trim()
}

// ---- Bridge-owned attachment delivery ---------------------------------------
// Marker form (one per line):  [[send-file: <path> | <optional caption>]]
// Paths are relative to WORKSPACE. The bridge strips markers from the reply text,
// validates each path, and uploads bound to the originating chat id.
const FILE_MARKER = /^[ \t]*\[\[send-file:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\][ \t]*$/gm
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024 // Telegram bot API rejects uploads over 50 MB

export function extractAttachments(text) {
  const files = []
  const stripped = String(text || '').replace(FILE_MARKER, (_m, p, caption) => {
    files.push({ path: p.trim(), caption: (caption || '').trim() })
    return ''
  })
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), files }
}

// Confine sends to WORKSPACE. realpath first so symlinks and ../ escapes are caught
// after resolution, not before — a marker must not be able to name /etc/shadow.
export function resolveAttachment(p, workspace = WORKSPACE) {
  let abs, root
  try { root = realpathSync(workspace) } catch { return { ok: false, error: `workspace unavailable` } }
  try { abs = realpathSync(resolve(root, p)) } catch { return { ok: false, error: `not found: ${p}` } }
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, error: `outside workspace: ${p}` }
  const st = statSync(abs)
  if (!st.isFile()) return { ok: false, error: `not a file: ${p}` }
  if (st.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `too large (${(st.size / 1048576).toFixed(1)} MB, limit ${MAX_UPLOAD_BYTES / 1048576} MB): ${p}` }
  }
  return { ok: true, abs, size: st.size }
}

export async function sendDocument(chatId, abs, caption) {
  const fd = new FormData()
  fd.append('chat_id', String(chatId))
  if (caption) fd.append('caption', caption.slice(0, 1024))
  fd.append('document', await openAsBlob(abs), basename(abs))
  const r = await fetch(`${API}/sendDocument`, { method: 'POST', body: fd })
  return r.json()
}

// Upload each marker's file to the chat the request came from. Failures are reported
// into the chat rather than thrown, so one bad path can't lose the rest of the reply.
export async function deliverAttachments(chatId, files) {
  for (const f of files) {
    const v = resolveAttachment(f.path)
    if (!v.ok) { await sendChunked(chatId, `⚠️ Could not send file — ${v.error}`); continue }
    try {
      const res = await sendDocument(chatId, v.abs, f.caption)
      if (!res?.ok) await sendChunked(chatId, `⚠️ Telegram rejected ${basename(v.abs)}: ${res?.description || 'unknown error'}`)
      else console.log(`[bridge] sent ${basename(v.abs)} (${v.size} B) to ${chatId}`)
    } catch (e) {
      await sendChunked(chatId, `⚠️ Upload failed for ${basename(v.abs)}: ${e?.message || e}`)
    }
  }
}

async function sendChunked(chatId, text) {
  const t = text || '(no output)'
  for (let i = 0; i < t.length; i += 3900) {
    await tg('sendMessage', { chat_id: chatId, text: t.slice(i, i + 3900) })
  }
}

// Ask the (oversized) session to write a handoff note for the next, fresh session. Read-only
// (plan mode) and time-boxed; callers treat any failure as "no summary" and fall back to a clean reset.
async function summarizeSession(sid) {
  const prompt = 'This conversation is being archived and a fresh session started to keep things fast. Write a concise handoff note (<400 words) for your future self so you can continue seamlessly: the current goal/task, key decisions and facts established, relevant file paths or system state, and any pending next steps. Output ONLY the note.\n\nDo NOT record how anything was delivered to the user: no chat ids, no bot names, no delivery commands. Message delivery is handled by the bridge and is never the agent\'s concern — mentioning it teaches the next session to send to the wrong place.'
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--resume', sid]
  if (SUMMARY_MODEL) args.push('--model', SUMMARY_MODEL)
  const stdout = await run(CLAUDE_BIN, args, { cwd: WORKSPACE, env: { ...process.env }, timeoutMs: 1000 * 60 * 5 })
  try { const j = JSON.parse(stdout); return (j.result || '').trim() } catch { return stdout.trim() }
}

// Run a single prompt through Claude Code, scoped to the workspace, resuming the chat's session.
async function runClaude(chatId, prompt) {
  const sid = getSession(chatId)
  // First message of a fresh session: prepend any carried-over summary so context survives a reset.
  const pendingSummary = sid ? null : getSummary(chatId)
  const body = pendingSummary
    ? `[Context carried over from our earlier conversation — use it for continuity; don't recite it back unless asked.]\n${scrubSummary(pendingSummary)}\n\n---\nUser's message:\n${prompt}`
    : prompt
  const effectivePrompt = `${DELIVERY_DIRECTIVE}\n\n---\n${body}`
  const args = ['-p', effectivePrompt, '--output-format', 'json', '--permission-mode', PERMISSION_MODE]
  if (MODEL) args.push('--model', MODEL)
  if (sid) args.push('--resume', sid)
  const stdout = await run(CLAUDE_BIN, args, { cwd: WORKSPACE, env: childEnv(chatId) })
  let result = stdout, newSid = null
  try { const j = JSON.parse(stdout); result = j.result ?? stdout; newSid = j.session_id ?? null } catch {}
  // Clear the carry-over once the new session is saved. Also clear it when this message
  // started WITHOUT one: any note that landed mid-flight belongs to the session we just
  // retired, and this new session already has its own history — using it later would
  // splice stale context into an unrelated conversation.
  if (newSid) { setSession(chatId, newSid); setSummary(chatId, '') }
  return result
}

let offset = 0
let busy = false
const queue = []

// Poll backoff + log dedupe. A transient Telegram/network blip would otherwise emit one
// "poll error: fetch failed" per retry (1000s of identical lines), burying any real
// signal, on a fixed 3s retry. Instead we back off exponentially (3s → 60s cap) and
// collapse a failure streak into a few escalating checkpoint lines (logged at the 1st,
// 2nd, 4th, 8th… failure or whenever the error text changes), plus a one-line recovery
// note when polling resumes.
const POLL_BACKOFF_BASE = 3000
const POLL_BACKOFF_MAX = 60_000
let pollFailures = 0
let lastPollErr = null
let pollFailStart = 0

// Rollover runs AFTER the reply, never before it. Summarizing in-line would make the
// user watch a "trimming…" notice and then wait on a full summarization pass (up to
// 5 min) before their own message even started.
//
// The session id is retired synchronously, before the background summarize begins, so
// the next message can never resume the same transcript while the summarizer is still
// reading it. Cost of that ordering: if a follow-up arrives before the note is ready it
// starts cold with no carry-over, which is why runClaude discards a note that lands late.
const rolling = new Set()

function maybeRollover(chatId) {
  const sid = getSession(chatId)
  if (!sid || rolling.has(chatId)) return
  const bytes = sessionBytes(sid)
  if (bytes <= MAX_SESSION_BYTES) return

  rolling.add(chatId)
  setSession(chatId, '') // retire now; the next message starts a fresh session
  console.log(`[bridge] rollover ${chatId}: session ${sid} at ${bytes} B > ${MAX_SESSION_BYTES} B`)

  ;(async () => {
    let summary = null
    try { summary = await summarizeSession(sid) }
    catch (e) { console.error('[bridge] summarize failed:', e?.message || e) }
    setSummary(chatId, scrubSummary(summary) || '')
    try {
      await tg('sendMessage', { chat_id: chatId, text: '🧹 Trimmed conversation memory in the background (kept replies fast and costs down). The important context carries forward.' })
    } catch {}
  })()
    .catch(e => console.error('[bridge] rollover error:', e?.message || e))
    .finally(() => rolling.delete(chatId))
}

async function processOne(msg) {
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()
  if (!text) return
  if (text === '/reset') { try { writeFileSync(sessFile(chatId), ''); writeFileSync(summaryFile(chatId), '') } catch {}; return tg('sendMessage', { chat_id: chatId, text: '🧹 Conversation reset.' }) }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
  try {
    const out = await runClaude(chatId, text)
    const { text: reply, files } = extractAttachments(out)
    // Skip the text send only when it is empty *and* a file is coming, so an
    // attachment-only reply doesn't emit a bare "(no output)" line first.
    if (reply || files.length === 0) await sendChunked(chatId, reply)
    await deliverAttachments(chatId, files)
  } catch (e) {
    await sendChunked(chatId, `⚠️ Error: ${e?.message || e}`)
  }
  maybeRollover(chatId) // deliberately not awaited — the reply is already sent
}

async function pump() {
  if (busy) return
  busy = true
  // try/finally guarantees `busy` resets even if processOne throws — otherwise an
  // unhandled rejection (e.g. a tg() network blip in the summarize path) would leave
  // busy=true forever, silently wedging the queue with no auto-recovery (systemd only
  // restarts on EXIT, not on a hang). Per-message catch keeps one bad message from
  // stalling the rest of the queue.
  try {
    while (queue.length) {
      const m = queue.shift()
      try { await processOne(m) }
      catch (e) { console.error('[bridge] processOne failed:', e?.message || e) }
    }
  } finally {
    busy = false
  }
}

async function loop() {
  console.log(`[bridge] up. workspace=${WORKSPACE} mode=${PERMISSION_MODE} allowed=${[...ALLOWED].join(',')}`)
  for (;;) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
      if (pollFailures > 0) {
        const since = Math.round((Date.now() - pollFailStart) / 1000)
        console.log(`[bridge] poll recovered after ${pollFailures} failure(s) over ${since}s`)
        pollFailures = 0
        lastPollErr = null
      }
      for (const u of data.result || []) {
        offset = u.update_id + 1
        const msg = u.message
        if (!msg || !msg.chat) continue
        if (!ALLOWED.has(String(msg.chat.id))) {
          console.log(`[bridge] ignoring chat ${msg.chat.id} (not allowed)`)
          continue
        }
        queue.push(msg)
      }
      pump()
    } catch (e) {
      const msg = e?.message || String(e)
      pollFailures++
      const now = Date.now()
      if (pollFailures === 1) pollFailStart = now
      // Log on the 1st failure, whenever the error text changes, and at exponentially
      // spaced checkpoints (powers of two) — so a sustained outage yields ~log2(N) lines
      // instead of one per retry, while a changed error still surfaces immediately.
      const isCheckpoint = (pollFailures & (pollFailures - 1)) === 0
      if (msg !== lastPollErr || isCheckpoint) {
        const since = Math.round((now - pollFailStart) / 1000)
        console.error(`[bridge] poll error (${pollFailures}x over ${since}s): ${msg}`)
        lastPollErr = msg
      }
      const delay = Math.min(POLL_BACKOFF_BASE * 2 ** (pollFailures - 1), POLL_BACKOFF_MAX)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// BRIDGE_NO_START lets tests import this module without starting the poller.
if (!process.env.BRIDGE_NO_START) loop()
