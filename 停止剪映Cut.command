#!/bin/bash
# 《剪映Cut》停止服务

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HERE/jianyingcut.conf"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
PORT="${PORT:-4000}"

stopped=0

if [ -f "$HERE/jianyingcut.pid" ]; then
  PID="$(cat "$HERE/jianyingcut.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    stopped=1
    echo "已停止 pid $PID"
  fi
  rm -f "$HERE/jianyingcut.pid"
fi

# 兜底：pid 文件丢了但端口还占着，按端口找
PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null
  echo "已停止占用 $PORT 端口的进程：$PIDS"
  stopped=1
fi

if [ "$stopped" = "0" ]; then
  echo "没有在运行的服务。"
fi

sleep 1
echo "完成。"
