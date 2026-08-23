#!/usr/bin/env bash
# 一条命令把 TradingView Desktop 带 CDP 启动（默认端口 9222）。
#   bash tv_launch.sh [port]
# 幂等：CDP 已就绪就什么都不做；没就绪才启动。
# 启动策略（按序回退）：
#   1) 直接带 flag 启动（TVD_DEBUGMODE=true + --remote-debugging-port）——多数情况可用，
#      含本机 TV 3.2.0 / Electron 38.2.2 实测好使。
#   2) macOS 回退 `open -a ... --args`：经 LaunchServices 透传 flag——
#      给 Electron 38+ 某些构建直接 spawn 被拒收 flag 的用户（upstream issue #13）。
set -uo pipefail
PORT="${1:-9222}"

cdp_up() { curl -s "http://localhost:${PORT}/json/version" >/dev/null 2>&1; }
poll_cdp() { for _ in $(seq 1 15); do sleep 1; cdp_up && return 0; done; return 1; }

# 0. 已经通就什么都不做（非破坏，最常见）
if cdp_up; then
  UA="$(curl -s "http://localhost:${PORT}/json/version" | grep -o 'TVDesktop/[0-9.]*' | head -1)"
  echo "✓ CDP 已在 :${PORT} 就绪，无需重启 TradingView（${UA:-running}）"
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    TV_APP="/Applications/TradingView.app"
    [ -d "$TV_APP" ] || TV_APP="$HOME/Applications/TradingView.app"
    TV_BIN="$TV_APP/Contents/MacOS/TradingView"
    if [ ! -x "$TV_BIN" ]; then
      echo "✗ 没找到 TradingView.app（查过 /Applications 和 ~/Applications）"
      echo "  → 装桌面端：https://www.tradingview.com/desktop/"
      exit 1
    fi
    # 先 kill 旧实例：否则 open -a 只会激活无 CDP 的旧窗口
    pkill -f TradingView 2>/dev/null && sleep 2

    # 1. 直接带 flag 启动
    echo "启动 TradingView（直接带 flag）…"
    TVD_DEBUGMODE=true "$TV_BIN" --remote-debugging-port="${PORT}" >/dev/null 2>&1 &
    if poll_cdp; then echo "✓ 直接启动成功，CDP 就绪于 :${PORT}"; exit 0; fi

    # 2. 回退 open -a（透传 flag 经 LaunchServices）
    echo "直接启动未就绪，回退 open -a …"
    pkill -f TradingView 2>/dev/null && sleep 2
    open -a "$TV_APP" --args --remote-debugging-port="${PORT}" || true
    if poll_cdp; then echo "✓ open -a 回退启动成功，CDP 就绪于 :${PORT}"; exit 0; fi

    echo "✗ 启动后 CDP 仍未就绪。手动试：open -a \"$TV_APP\" --args --remote-debugging-port=${PORT}"
    exit 1 ;;
  Linux)
    TV_BIN="$(command -v tradingview || echo /opt/TradingView/tradingview)"
    [ -x "$TV_BIN" ] || { echo "✗ 没找到 tradingview 可执行文件，装桌面端：https://www.tradingview.com/desktop/"; exit 1; }
    pkill -f TradingView 2>/dev/null && sleep 2
    "$TV_BIN" --remote-debugging-port="${PORT}" >/dev/null 2>&1 &
    if poll_cdp; then echo "✓ 启动成功，CDP 就绪于 :${PORT}"; exit 0; fi
    echo "✗ 启动后 CDP 仍未就绪。手动试：$TV_BIN --remote-debugging-port=${PORT}"; exit 1 ;;
  *)
    echo "✗ Windows 请手动启动：\"%LOCALAPPDATA%\\TradingView\\TradingView.exe\" --remote-debugging-port=${PORT}"
    exit 1 ;;
esac