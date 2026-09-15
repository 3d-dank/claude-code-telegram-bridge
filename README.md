# claude-code-telegram-bridge

Bridge a Telegram chat to a [Claude Code](https://claude.com/product/claude-code)
CLI session. Message a bot, it runs `claude -p` against your project, and the
reply (and any files Claude wants to send you) comes back in the same chat.

Built and hardened over months of real production use running a small
business's ops. Anthropic has since shipped an
[official Telegram channel](https://code.claude.com/docs/en/channels)
(research preview, as of late 2026) that takes a different approach — it
injects messages into one already-running interactive session. This bridge
instead spawns a fresh headless `claude -p` per message, which is a better
fit if you want an always-on group chat with multiple people, don't want to
keep a terminal session open, or want the message-delivery security model
described below. Pick whichever fits your setup; they're not mutually
exclusive.

## Why not just give the agent Telegram credentials?

Because then a bug, a bad guess, or a prompt injection in an incoming
message can send a message or a file to the wrong place — and "wrong place"
in a group chat means the wrong *people*. This bridge was built after
exactly that happened: an agent, asked to deliver a file, guessed which chat
it was talking to from memory instead of being told, and sent a customer
file to the wrong group. Twice.

The fix is defense in depth, not a single check:

1. **The child process never gets the bot token.** `childEnv()` strips
   `TELEGRAM_BOT_TOKEN` before spawning Claude. The agent cannot talk to
   Telegram directly, full stop — not a policy, a capability it doesn't have.
2. **Chat identity comes from the inbound message, not a config file.** The
   originating chat id is injected as `TELEGRAM_CHAT_ID` on every request, so
   there's nothing for the agent to guess. Delivery is a marker
   (`[[send-file: path | caption]]`) that the bridge — not the agent —
   resolves and uploads, scoped to the chat the request came from.
2. **A standing directive is re-injected on every turn** (`DELIVERY_DIRECTIVE`)
   so the "you have no credentials, use the marker" instruction survives a
   session reset and can't be summarized away.
3. **Any other tool in the same environment with its own send credentials
   gets shimmed out of PATH** (see `shims/example-shim.sh`) — withholding
   this bridge's token doesn't help if the agent can reach a different tool
   that has its own.
4. **File paths are confined to the workspace.** `resolveAttachment()`
   resolves symlinks before checking containment, so `../` escapes and
   symlink tricks both get rejected, not just literal path traversal.

## Other things this handles that a naive bridge won't

- **Session cost blowup.** `claude -p --resume` reloads the entire
  transcript as context on every message. Left unbounded, a long-running
  group chat's per-message cost climbs and eventually starts hitting 429s.
  The bridge tracks each chat's transcript size and rolls over to a fresh
  session once it crosses `MAX_SESSION_BYTES`, first asking the outgoing
  session to write a short handoff summary so the user doesn't have to
  re-teach context.
- **IPv6 black-hole hangs.** Some hosts have a global IPv6 address but no
  working IPv6 route, and Node's Happy Eyeballs will try that address first
  against `api.telegram.org` and hang until timeout. Forced to IPv4 at
  startup.
- **Poll-failure log spam.** A transient network blip against a fixed 3s
  retry can produce thousands of identical log lines. Backs off
  exponentially (3s → 60s cap) and collapses a failure streak into a
  handful of checkpoint lines instead.
- **Zero runtime dependencies.** Just Node built-ins (`node:child_process`,
  `node:fs`, `fetch`). Nothing to audit in `node_modules`, nothing to fall
  behind on.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), copy
   the token.
2. `npm install` — installs nothing (zero deps), just validates your Node version.
3. `cp config.env.example config.env` and fill it in. See the comments in
   that file for what each variable does.
4. Message your bot (or add it to a group) to find the chat id, check
   `bridge.log` after your first message for the numeric chat id.
5. `node bridge.mjs` to run it directly, or install the included
   `claude-telegram-bridge.service.example` under systemd for an always-on
   deployment with auto-restart.
6. `node test-child-env.mjs` to run the test suite (no network, no real
   token needed).

## `PERMISSION_MODE`

Defaults to `plan` — Claude can read and analyze but not make changes. This
is the safe default for a bridge that's reachable by anyone in an allowed
chat. Only loosen it (e.g. to `default` or `acceptEdits`) if you understand
that everyone in `ALLOWED_CHAT_IDS` can then get Claude to make real changes
in `WORKSPACE`, unattended, with no one else in the loop to catch a mistake.
If your project has its own safety rules (e.g. "confirm before destructive
actions" in a `CLAUDE.md`), remember this bridge runs headless — there's no
terminal for Claude to actually pause and wait for a typed "yes" in. Write
your guardrails assuming Claude must ask *in the chat* and wait for a reply,
not assume a permission prompt will save you.

## Commands

- `/reset` — clear the chat's session and any carried-over summary, start
  completely fresh.

## License

MIT — see [LICENSE](LICENSE).
