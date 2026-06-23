#!/bin/bash
#
# wshell — Remote Shell Web 启停脚本
#
# Usage:
#   ./wshell.sh start          以默认配置启动 (绑定 :: 全接口, IPv4+IPv6)
#   ./wshell.sh stop           停止
#   ./wshell.sh restart        重启
#   ./wshell.sh status         查看运行状态
#
# Env:
#   PORT=3000                  服务端口
#   HOST=::                    绑定地址 (:: = 全接口, ::1 = IPv6 localhost, 0.0.0.0 = IPv4)
#   WSHELL_SCROLLBACK=10000    scrollback 行数
#   WSHELL_SESSION_TTL_MINUTES=30  空闲 session 超时(分钟)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/wshell.pid"
LOG_FILE="$SCRIPT_DIR/wshell.log"

# 默认配置
export PORT="${PORT:-3000}"
export HOST="${HOST:-::}"
export WSHELL_SCROLLBACK="${WSHELL_SCROLLBACK:-10000}"
export WSHELL_SESSION_TTL_MINUTES="${WSHELL_SESSION_TTL_MINUTES:-30}"
export WSHELL_EXIT_TTL_MINUTES="${WSHELL_EXIT_TTL_MINUTES:-5}"

# ── helpers ────────────────────────────────────────────────────

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE" 2>/dev/null
  fi
}

# ── commands ───────────────────────────────────────────────────

cmd_start() {
  if is_running; then
    echo "wshell is already running (pid $(get_pid))"
    echo "  http://[::1]:$PORT  (IPv6 localhost)"
    return 1
  fi

  # Clean up stale PID file
  rm -f "$PID_FILE"

  echo -n "Starting wshell..."
  nohup node "$SCRIPT_DIR/server.js" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait a moment to see if it crashes immediately
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo " done (pid $pid)"
    echo ""
    echo "  Local access:"
    if [ "$HOST" = "::" ] || [ "$HOST" = "::1" ]; then
      echo "    http://[::1]:$PORT  (IPv6 localhost)"
      echo "    http://127.0.0.1:$PORT  (IPv4 localhost)"
    else
      echo "    http://$HOST:$PORT"
    fi
    echo ""
    echo "  Logs: tail -f $LOG_FILE"
    echo "  Stop: ./wshell.sh stop"
  else
    echo " FAILED"
    rm -f "$PID_FILE"
    echo "  Check $LOG_FILE for errors"
    return 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "wshell is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid=$(get_pid)
  echo -n "Stopping wshell (pid $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait up to 10 seconds for graceful shutdown
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done

  # Force kill if still alive
  if kill -0 "$pid" 2>/dev/null; then
    echo -n " forcing..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  echo " stopped"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(get_pid)
    echo "wshell is running (pid $pid)"
    echo "  http://[::1]:$PORT  (IPv6 localhost)"
    echo "  http://127.0.0.1:$PORT  (IPv4 localhost)"
    echo "  Log: $LOG_FILE"

    # Show session count via API
    local count
    count=$(curl -s "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null) || true
    if [ -n "$count" ]; then
      echo "  Sessions: $count active"
    fi
  else
    echo "wshell is not running"
    rm -f "$PID_FILE"
  fi
}

# ── dispatch ───────────────────────────────────────────────────

case "${1:-}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    echo ""
    echo "  start    启动服务 (默认绑定 :: 全接口, IPv4+IPv6 双栈)"
    echo "  stop     停止服务"
    echo "  restart  重启服务"
    echo "  status   查看状态"
    echo ""
    echo "  PORT=3000 HOST=:: $0 start"
    exit 1
    ;;
esac
