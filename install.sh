#!/usr/bin/env bash
# dsh-irc 一键安装脚本
#
# 用法:
#   ./install.sh                 # 安装到默认位置
#   ./install.sh --bot-only      # 只安装/启动 IRC bot（不装 DSH 插件）
#   ./install.sh --uninstall     # 停止 bot 并移除安装
#
# 说明:
#   - 把 irc-bot/ 复制到 $DST_BOT_DIR（默认 ~/.dsh/irc-bot）
#   - 把 plugin/ 复制到 $DST_PLUGIN_DIR（默认 ~/.dsh/irc-plugin）
#   - 启动 supervisor (run.sh) 保持 bot 运行
#   - DSH 插件需在 DSH 中加载 host.js + client.js（本脚本给出提示）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST_BOT_DIR="${DST_BOT_DIR:-$HOME/.dsh/irc-bot}"
DST_PLUGIN_DIR="${DST_PLUGIN_DIR:-$HOME/.dsh/irc-plugin}"
LOG_DIR="${IRC_BOT_LOG_DIR:-$HOME/.dsh/irc-bot}"

MODE="all"

for arg in "$@"; do
  case "$arg" in
    --bot-only) MODE="bot" ;;
    --uninstall) MODE="uninstall" ;;
    -h|--help) echo "用法: $0 [--bot-only|--uninstall|--help]"; exit 0 ;;
  esac
done

if [ "$MODE" = "uninstall" ]; then
  echo "[dsh-irc] 停止 bot 与 supervisor..."
  pkill -f "node irc-bot.js" 2>/dev/null || true
  pkill -f "irc-bot/run.sh" 2>/dev/null || true
  echo "[dsh-irc] 已停止。如需删除文件，请手动移除:"
  echo "  $DST_BOT_DIR"
  echo "  $DST_PLUGIN_DIR"
  exit 0
fi

echo "[dsh-irc] 安装目录: $DST_BOT_DIR"
mkdir -p "$DST_BOT_DIR" "$DST_PLUGIN_DIR"

# 复制 bot 文件
cp "$SCRIPT_DIR/irc-bot/irc-bot.js" "$DST_BOT_DIR/"
cp "$SCRIPT_DIR/irc-bot/run.sh" "$DST_BOT_DIR/"
if [ ! -f "$DST_BOT_DIR/irc.json" ]; then
  cp "$SCRIPT_DIR/irc-bot/irc.json" "$DST_BOT_DIR/"
  echo "[dsh-irc] 已复制默认 irc.json，请编辑配置服务器/nick/频道/LLM"
else
  echo "[dsh-irc] 保留已有 irc.json"
fi
chmod +x "$DST_BOT_DIR/run.sh"

# 复制插件文件
cp "$SCRIPT_DIR/plugin/host.js" "$SCRIPT_DIR/plugin/client.js" "$SCRIPT_DIR/plugin/plugin.json" "$DST_PLUGIN_DIR/"

echo "[dsh-irc] 文件已安装。"
echo

if [ "$MODE" != "bot" ]; then
  echo "=== 下一步 ==="
  echo "1. 编辑 $DST_BOT_DIR/irc.json 配置"
  echo "2. 在 DSH 中把以下两个文件加载为 Cordis 插件 (irct-4):"
  echo "     host:   $DST_PLUGIN_DIR/host.js"
  echo "     client: $DST_PLUGIN_DIR/client.js"
  echo "3. 刷新浏览器，侧边栏底部出现 IRC 按钮"
  echo
fi

# 启动 supervisor（bot 自动重启）
echo "[dsh-irc] 启动 supervisor..."
cd "$DST_BOT_DIR" && setsid nohup bash run.sh >/dev/null 2>&1 &
echo "[dsh-irc] supervisor 已启动 (PID $!). 日志: $LOG_DIR/bot-supervisor.log"
