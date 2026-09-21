# Hermes Agent with group-butler's WhatsApp bridge patch baked in.
#
# Why an image rather than a mount: the patch must survive a container being
# recreated. `docker cp` into a running container is undone by the next deploy,
# and the failure is silent — the bridge still starts and still connects, it just
# stops archiving and stops accepting group actions. A deploy that quietly loses
# half its features is worse than one that refuses to start.
#
# The base is pinned to the release the patch was written against. The patcher
# asserts each of its four anchors and exits non-zero if one has moved, so a base
# bump fails the build here instead of shipping an unpatched bridge to production.
FROM nousresearch/hermes-agent:v2026.6.5 AS production

# The bridge patch, the Python adapter compatibility patch, and the two bridge
# snippets they splice into the pinned Hermes release.
COPY patch-bridge.mjs patch-whatsapp.mjs bridge-archive-forwarder.js bridge-group-actions.js /tmp/bridge-patch/

# Read the shipped bridge, write the patched one beside it, prove it parses, and
# only then put it in place — so a broken patch can never become the file the
# container runs.
RUN set -eu; \
    BRIDGE=/opt/hermes/scripts/whatsapp-bridge/bridge.js; \
    node /tmp/bridge-patch/patch-bridge.mjs "$BRIDGE" /tmp/bridge-patch/bridge.patched.js; \
    node --check /tmp/bridge-patch/bridge.patched.js; \
    mv /tmp/bridge-patch/bridge.patched.js "$BRIDGE"; \
    WHATSAPP=/opt/hermes/gateway/platforms/whatsapp.py; \
    node /tmp/bridge-patch/patch-whatsapp.mjs "$WHATSAPP" /tmp/bridge-patch/whatsapp.patched.py; \
    python -m py_compile /tmp/bridge-patch/whatsapp.patched.py; \
    mv /tmp/bridge-patch/whatsapp.patched.py "$WHATSAPP"; \
    chmod 0644 "$BRIDGE" "$WHATSAPP"; \
    rm -rf /tmp/bridge-patch

# The pairing/status service. Started by the container's command rather than
# registered with s6: s6-overlay compiles its database from this directory at
# start-up and did not pick the service up, and the command is also the one surface
# a host like EasyPanel can express without depending on image internals.
# The config template and the start script that installs it. Both live in the image
# so a deployment needs one container and one command, with no separate seeding step
# -- which is the only shape that works where services are deployed one at a time.
COPY config.yaml /opt/hermes/docker/config.yaml
COPY butler-start.sh /opt/hermes/docker/butler-start.sh
RUN chmod 0755 /opt/hermes/docker/butler-start.sh
COPY pairing-service.mjs /opt/hermes/docker/butler-pairing.mjs

# Bake document generators into the image; runtime installs disappear on deploy.
COPY verify-document-runtime.py /tmp/verify-document-runtime.py
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache \
        python-docx==1.2.0 \
        reportlab==5.0.1 && \
    /opt/hermes/.venv/bin/python /tmp/verify-document-runtime.py && \
    rm /tmp/verify-document-runtime.py

# The bridge's dependencies, installed at build time. The pairing wizard installs
# them on first use otherwise, which takes minutes during which it prints nothing --
# so a fresh volume looks exactly like a hang, on the one screen where the operator
# is waiting for a QR. Baking them in makes pairing immediate and removes that wait
# from every deployment rather than only from the second one.
RUN cd /opt/hermes/scripts/whatsapp-bridge && npm install --no-fund --no-audit --progress=false

# Documented here as well as in the README because the failure is non-obvious:
# with the default loopback bind, the worker and console in sibling containers
# cannot reach the bridge, and every group action reports "unreachable" while the
# bridge looks healthy from inside its own container.
ENV WHATSAPP_BRIDGE_BIND=0.0.0.0
