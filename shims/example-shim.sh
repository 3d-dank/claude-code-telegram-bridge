#!/usr/bin/env bash
# Example PATH shim — copy this pattern if you run another CLI in the same
# environment that carries its OWN messaging credentials (a different bot, a
# different Slack app, an email sender, etc). Withholding the bridge's own
# TELEGRAM_BOT_TOKEN from the child process (see childEnv() in bridge.mjs)
# does not stop the agent from using THAT other tool to send a message
# somewhere you didn't intend — a real incident that motivated this bridge's
# design: an agent under time pressure reached for a different tool with its
# own send credentials and shipped a file to the wrong destination.
#
# Rename this file to match the real binary name (e.g. `slack-cli`), and set
# SHIM_DIR (or rely on the default `shims/` next to bridge.mjs) so it's
# first on the child's PATH. Block only the specific dangerous subcommand;
# pass everything else through untouched so the rest of the tool still works.

REAL="/usr/local/bin/REPLACE_WITH_REAL_BINARY_NAME"

dangerous=0
for a in "$@"; do
  case "$a" in
    send|message|notify) dangerous=1 ;;
  esac
done

if [ "$dangerous" = 1 ]; then
  cat >&2 <<'EOF'
blocked: this subcommand is disabled for agents running under the bridge.
It would send through different credentials than the bridge uses.

To deliver a file to the chat you are talking to, emit this on its own line
in your reply: [[send-file: <path relative to workspace> | <caption>]]
The bridge performs the upload — you do not have, and do not need, any
messaging credentials of your own.
EOF
  exit 1
fi

exec "$REAL" "$@"
