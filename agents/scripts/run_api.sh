#!/usr/bin/env bash
# Start the Cameo detection API on 127.0.0.1:8787. Extra args go to uvicorn (e.g. --reload).
cd "$(dirname "$0")/.." || exit 1
exec .venv/bin/uvicorn cameo_agents.api:app --host 127.0.0.1 --port 8787 "$@"
