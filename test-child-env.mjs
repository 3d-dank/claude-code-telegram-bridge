// Regression tests for chat-identity propagation and bridge-owned attachment delivery.
//
// Background: an early version let the child Claude guess which chat to reply to,
// and a wrong guess shipped a file to the wrong destination. The bridge now owns
// delivery and withholds the bot token so the agent has no way to do that itself.
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'

const TEST_CHAT_ID = -100123456789 // placeholder group chat id, not a real one

process.env.TELEGRAM_BOT_TOKEN = 'test:token'
process.env.ALLOWED_CHAT_IDS = String(TEST_CHAT_ID)
process.env.BRIDGE_NO_START = '1'

const WS = '/tmp/bridge-test-ws'
rmSync(WS, { recursive: true, force: true })
mkdirSync(`${WS}/sub`, { recursive: true })
writeFileSync(`${WS}/report.csv`, 'a,b\n1,2\n')
writeFileSync(`${WS}/sub/nested.txt`, 'hi')
writeFileSync('/tmp/bridge-test-outside.txt', 'secret')
try { symlinkSync('/tmp/bridge-test-outside.txt', `${WS}/escape.txt`) } catch {}
process.env.WORKSPACE = WS

const { childEnv, extractAttachments, resolveAttachment, scrubSummary, DELIVERY_DIRECTIVE } = await import('./bridge.mjs')

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// --- chat identity ----------------------------------------------------------
const env = childEnv(TEST_CHAT_ID)
check('TELEGRAM_CHAT_ID is the originating chat', env.TELEGRAM_CHAT_ID === String(TEST_CHAT_ID))
check('bot token is WITHHELD from the child', env.TELEGRAM_BOT_TOKEN === undefined)
check('parent env otherwise inherited', env.ALLOWED_CHAT_IDS === String(TEST_CHAT_ID))
check('shim dir is prepended to PATH', env.PATH.split(':')[0].endsWith('/shims'))

// --- delivery directive ------------------------------------------------------
check('directive tells the agent it has no credentials', DELIVERY_DIRECTIVE.includes('NO Telegram credentials'))

// --- scrubSummary -------------------------------------------------------------
check('scrubSummary strips telegram API mentions', !scrubSummary('sent via api.telegram.org').includes('api.telegram.org'))
check('scrubSummary redacts long numeric ids', scrubSummary('sent to chat -100123456789').includes('<chat id removed'))
check('scrubSummary passes through clean text', scrubSummary('the task is done') === 'the task is done')

// --- extractAttachments -------------------------------------------------------
{
  const { text, files } = extractAttachments('Here is your file.\n[[send-file: report.csv | Q3 numbers]]\nLet me know if you need more.')
  check('extractAttachments strips the marker from text', !text.includes('[[send-file'))
  check('extractAttachments finds the file', files.length === 1 && files[0].path === 'report.csv')
  check('extractAttachments captures the caption', files[0].caption === 'Q3 numbers')
}

// --- resolveAttachment: path confinement --------------------------------------
check('resolveAttachment accepts a file inside the workspace', resolveAttachment('report.csv').ok === true)
check('resolveAttachment accepts a nested file', resolveAttachment('sub/nested.txt').ok === true)
check('resolveAttachment rejects a path outside the workspace', resolveAttachment('../bridge-test-outside.txt').ok === false)
check('resolveAttachment rejects a symlink escape', resolveAttachment('escape.txt').ok === false)
check('resolveAttachment rejects a missing file', resolveAttachment('does-not-exist.txt').ok === false)
check('resolveAttachment rejects a directory', resolveAttachment('sub').ok === false)

rmSync(WS, { recursive: true, force: true })
rmSync('/tmp/bridge-test-outside.txt', { force: true })

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall passed')
