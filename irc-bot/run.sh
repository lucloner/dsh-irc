#!/usr/bin/env bash
# IRC Bot supervisor — 确保 bot 始终运行，退出后自动重启
#
# 可移植：BOT_DIR 自动取脚本所在目录，LOG_DIR 可用环境变量覆盖。
#   IRC_BOT_LOG_DIR=/path/to/logs ./run.sh
set -e

# 脚本所在目录（即 bot 源码目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="${BOT_DIR:-$SCRIPT_DIR}"
LOG_DIR="${IRC_BOT_LOG_DIR:-$HOME/.dsh/irc-bot}"
LOG_FILE="$LOG_DIR/bot-supervisor.log"

mkdir -p "$LOG_DIR"

echo "[$(date -Iseconds)] IRC Bot supervisor starting (PID $$) BOT_DIR=$BOT_DIR" >> "$LOG_FILE"

# 精确匹配 bot 进程（node irc-bot.js），避免误匹配到含 'irc-bot.js' 字符串的其他进程（如 bash -c）
BOT_PAT='node irc-bot.js'

while true; do
  # 检查是否已有 bot 进程在运行
  if pgrep -f "$BOT_PAT" > /dev/null 2>&1; then
    echo "[$(date -Iseconds)] Bot already running, waiting 5s..." >> "$LOG_FILE"
    sleep 5
    continue
  fi

  echo "[$(date -Iseconds)] Starting irc-bot.js..." >> "$LOG_FILE"
  cd "$BOT_DIR" && setsid nohup node irc-bot.js > "$LOG_DIR/bot-stdout.log" 2>&1 &

  # 等待启动完成，检查进程
  sleep 3
  if pgrep -f "$BOT_PAT" > /dev/null 2>&1; then
    echo "[$(date -Iseconds)] Bot started successfully (PID $(pgrep -f "$BOT_PAT"))" >> "$LOG_FILE"
  else
    echo "[$(date -Iseconds)] Bot failed to start, retrying in 60s..." >> "$LOG_FILE"
    sleep 57  # 加上启动等待的3秒 = 60s
  fi

  # 每 60 秒检查一次 bot 是否存活
  sleep 60 &
  wait $!
done
