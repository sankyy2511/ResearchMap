#!/bin/sh
# Starts the AI service in the background, then the backend in the foreground. If either stops, the container stops.
set -e
cd /app/agent
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
AI_PID=$!
cd /app
API_ADDR=":${PORT:-8080}" ./server &
API_PID=$!
# Exit as soon as one process exits, so the host restarts the container.
while kill -0 "$AI_PID" 2>/dev/null && kill -0 "$API_PID" 2>/dev/null; do sleep 5; done
exit 1
