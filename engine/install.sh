#!/usr/bin/env bash
# 一键装机 / 环境自检（OS 感知，缺啥给具体命令）。
#   bash install.sh          安装依赖 + 全量自检
#   bash install.sh --check  只读预检（不装依赖）
set -uo pipefail
cd "$(dirname "$0")"
CHECK_ONLY=0; [ "${1:-}" = "--check" ] && CHECK_ONLY=1
green(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
red(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=1; }
hint(){ printf "      \033[33m→\033[0m %s\n" "$1"; }
FAIL=0

OS="$(uname -s)"
case "$OS" in
  Darwin) TV_PATH="/Applications/TradingView.app/Contents/MacOS/TradingView"
          NODE_HINT="brew install node   （或从 https://nodejs.org 下载 LTS）"
          TV_DL="https://www.tradingview.com/desktop/"
          LAUNCH="TVD_DEBUGMODE=true $TV_PATH --remote-debugging-port=9222 &" ;;
  Linux)  TV_PATH="$(command -v tradingview || echo /opt/TradingView/tradingview)"
          NODE_HINT="用 nvm: 'nvm install 20'  或发行版包管理器（apt/dnf）装 Node ≥18"
          TV_DL="https://www.tradingview.com/desktop/"
          LAUNCH="$TV_PATH --remote-debugging-port=9222 &" ;;
  *)      TV_PATH=""
          NODE_HINT="从 https://nodejs.org 装 LTS（≥18）"
          TV_DL="https://www.tradingview.com/desktop/"
          LAUNCH="\"%LOCALAPPDATA%\\TradingView\\TradingView.exe\" --remote-debugging-port=9222" ;;
esac

echo "[1] Node ≥ 18"
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if [ "$MAJOR" -ge 18 ]; then green "node $(node -v)"; else red "node $(node -v) 太旧（需 ≥18）"; hint "$NODE_HINT"; fi
else
  red "未找到 node"; hint "$NODE_HINT"
fi

if [ "$CHECK_ONLY" -eq 0 ]; then
  echo "[2] 安装依赖（npm install）"
  if command -v npm >/dev/null 2>&1; then
    if ERR=$(npm install 2>&1); then green "chrome-remote-interface 等依赖已装"
    else red "npm install 失败"; echo "$ERR" | tail -3 | sed 's/^/      /'; fi
  else
    red "未找到 npm（随 Node 一起装）"; hint "$NODE_HINT"
  fi
else
  echo "[2] 依赖检查"
  [ -d node_modules/chrome-remote-interface ] && green "依赖已装" || { red "未装依赖"; hint "去掉 --check 跑一次：bash install.sh"; }
fi

echo "[3] TradingView 桌面版"
if [ -n "$TV_PATH" ] && { [ -e "$TV_PATH" ] || [ -d "/Applications/TradingView.app" ]; }; then
  green "已安装"
elif command -v tradingview >/dev/null 2>&1; then green "$(command -v tradingview)"
else
  red "未找到 TradingView 桌面版（必须桌面版，网页版无法 CDP 注入）"
  hint "下载: $TV_DL  装好后用账号登录一次"
fi

echo "[4] CDP 9222 可达（TV 用调试端口启动）"
if curl -s --max-time 3 http://localhost:9222/json/version >/dev/null 2>&1; then
  green "CDP 已在（$(curl -s --max-time 3 http://localhost:9222/json/version | grep -o 'TVDesktop/[0-9.]*' | head -1)）"
else
  red "CDP 未启动"
  hint "一条命令启动（幂等，自动选可用方式）: bash tv_launch.sh"
  hint "或手动: $LAUNCH"
  [ "$OS" = "Darwin" ] && hint "Mac 必须带 TVD_DEBUGMODE=true，否则报 bad option（可忽略 stderr）；终端窗口保持开着"
fi

echo "[5] 输出目录"
OUT="${TV_SKILL_OUTPUT_DIR:-$HOME/.tv-skill}"
mkdir -p "$OUT" 2>/dev/null && green "$OUT" || red "无法创建 $OUT"

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf "\033[32m✅ 环境就绪\033[0m。验证：npm run check（静态） / npm run selftest（端到端，需 TV）。\n"
else
  printf "\033[31m❌ 有项未就绪\033[0m，按上面 → 提示逐个修复。完整说明见同目录上层的 SETUP.md。\n"; exit 1
fi