#!/bin/sh
# Container start for the group-butler Hermes deployment: install the config, run
# the pairing/status service, and hand over to the gateway.
#
# Why this exists rather than a seed container: on a host like EasyPanel you deploy
# one container at a time, and there is no "run this other thing first" step. The
# config ships inside the image and the container installs it on its way up, so a
# fresh volume is a working deployment with a single command and nothing to
# remember.
#
# The template is copied on EVERY start, not just the first, because `$HERMES_HOME`
# also holds the WhatsApp session and must therefore be a persistent volume — and a
# volume that keeps an old config is how a change to `.env` silently does nothing.
# Edit `infra/hermes/config.yaml` in the repository; anything edited inside the
# volume is replaced here.
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
TEMPLATE=/opt/hermes/docker/config.yaml

# Fill the two values that belong to the deployment rather than the image. `sed`
# rather than `envsubst`: the base image does not ship gettext, and two literal
# placeholders need no templating engine.
sed -e "s|__AI_BASE_URL__|${AI_BASE_URL:-}|g" \
    -e "s|__AI_MODEL__|${AI_MODEL:-}|g" \
    -e "s|__MCP_BUTLER_URL__|${MCP_BUTLER_URL:-}|g" \
    -e "s|__MCP_BUTLER_TOKEN__|${MCP_BUTLER_TOKEN:-}|g" \
    "$TEMPLATE" > "$HERMES_HOME/config.yaml"
chmod 600 "$HERMES_HOME/config.yaml"
# The gateway runs as the hermes user, which must be able to read what root wrote.
chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
echo "[butler-start] config installed from the image template"

# The status/pairing service. It listens on all interfaces because the console and
# the worker reach it from their own containers.
node /opt/hermes/docker/butler-pairing.mjs &

# The operator's command, unchanged: this script must not become a second thing
# that decides how the gateway runs.
exec "$@"
