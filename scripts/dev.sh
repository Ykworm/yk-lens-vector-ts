#!/usr/bin/env bash
# yk-vector-ts 开发启停
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PID_FILE="$ROOT/data/yk-vector-ts.pid"
LOG_FILE="$ROOT/data/yk-vector-ts.log"
mkdir -p "$ROOT/data"

cmd="${1:-}"
case "$cmd" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "already running pid=$(cat "$PID_FILE")"
      exit 0
    fi
    if [ ! -f configs/yk-vector-ts.yaml ] && [ -f configs/yk-vector-ts.example.yaml ]; then
      cp configs/yk-vector-ts.example.yaml configs/yk-vector-ts.yaml
      echo "created configs/yk-vector-ts.yaml from example"
    fi
    nohup npx tsx src/index.ts --config configs/yk-vector-ts.yaml >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "started pid=$! log=$LOG_FILE"
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PID_FILE")"
      curl -s "http://127.0.0.1:${YK_VECTOR_PORT:-8703}/healthz" || true
      echo
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 start|stop|status"
    exit 1
    ;;
esac
