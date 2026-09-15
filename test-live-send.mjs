// Live end-to-end check of bridge-owned delivery. Runs the REAL production path:
// a simulated agent reply -> extractAttachments -> deliverAttachments -> Telegram.
// Sends to ALLOWED_CHAT_IDS[0]. Requires a real config.env loaded into the
// environment. Run: node --env-file=config.env test-live-send.mjs
process.env.BRIDGE_NO_START = '1'

const { extractAttachments, resolveAttachment, deliverAttachments } = await import('./bridge.mjs')

const chatId = (process.env.ALLOWED_CHAT_IDS || '').split(',')[0].trim()
if (!chatId) { console.error('ALLOWED_CHAT_IDS not set'); process.exit(1) }

// Exactly what the agent would now emit instead of shelling out to a messaging API.
// Point this at any small real file in your WORKSPACE before running.
const agentReply = [
  'Bridge test — a file is attached.',
  '[[send-file: package.json | Bridge delivery test]]',
  'Ignore this message; it is verifying attachment routing.',
].join('\n')

const { text, files } = extractAttachments(agentReply)
console.log('chat id    :', chatId)
console.log('reply text :', JSON.stringify(text))
console.log('files      :', JSON.stringify(files))

for (const f of files) {
  const v = resolveAttachment(f.path)
  console.log('resolved   :', v.ok ? `${v.abs} (${v.size} B)` : `REJECTED — ${v.error}`)
  if (!v.ok) process.exit(1)
}

await deliverAttachments(chatId, files)
console.log('deliverAttachments returned without throwing')
