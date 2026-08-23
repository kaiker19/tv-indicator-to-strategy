# 自动注入回测 — 安装指南

只需一次，约 5 分钟。引擎自包含在本技能的 `engine/` 目录，**不需要单独装 tradingview-mcp / 配 MCP server**。

## 1. 装 TradingView Desktop（必须桌面版）

https://www.tradingview.com/desktop/ → 装好 → 用账号登录一次（建议小号）。

> ⚠️ 必须用**桌面版**。网页版无法被 CDP 注入。详细排错见 [references.md](references.md)。

## 2. 用调试端口启动

**推荐：一条命令（幂等）**——CDP 已通就跳过、没通才启动，自动选可用方式：
```bash
bash <本技能目录>/engine/tv_launch.sh      # 默认端口 9222；可传 tv_launch.sh 9333
```
- Mac 上先试直接带 flag（`TVD_DEBUGMODE=true … --remote-debugging-port`），不行自动回退
  `open -a … --args`（Electron 38+ 某些构建直接 spawn 会拒收 flag 时用）。
- 看到 `✓ … CDP 就绪` 即可。

**手动启动**（想自己控制时），Mac 两种选其一：

**A. `open -a … --args`（推荐，社区标准）**——经 LaunchServices 启动，**脱离终端**（终端关了 TV 不死），
且通常**不需要 `TVD_DEBUGMODE`**：
```bash
open -a TradingView --args --remote-debugging-port=9222
```
- `--args` 后面的参数才会透传给 TV；裸 `open -a TradingView`（不带 `--args`）会把 flag 吞掉。
- `tv_launch.sh` 的回退用的就是这条。

**B. 直接跑 binary**——若 A 不行（部分 TV 3.x 构建会拒 flag），加 `TVD_DEBUGMODE=true`（**值是 `true` 不是 `1`**，
否则报 `bad option`，可忽略 stderr 警告）：
```bash
TVD_DEBUGMODE=true /Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222 &
```
- 末尾 `&` 后台跑，但**终端窗口要保持开着**（关掉会带走 TV）。

Windows：
```
"%LOCALAPPDATA%\TradingView\TradingView.exe" --remote-debugging-port=9222
```

打开后随便加一个图表（比如 AAPL），保持窗口运行。

## 3. 装引擎依赖 + 自检

```bash
cd <本技能目录>/engine
bash install.sh          # 装依赖 + 全量环境自检（Node / 依赖 / TV / CDP / 输出目录）
```
全绿即就绪。任何时候可只读预检：`bash install.sh --check`。

## 4. 验证

```bash
npm run check            # 静态自检（无需 TV）：装得上、无残留路径、CLI 正确
npm run selftest         # 端到端自检（需 TV 已启动）：捆绑策略跑一遍，断言 9 项 PASS/FAIL
```

`selftest` 返回 `PASS` 就代表整条链路（注入 → 回测 → 抓 8 字段 metrics → 图表清理）都正常。

---

输出默认写 `~/.tv-skill/`（`scan_results.jsonl` + `inject_proof.png`），可用 `TV_SKILL_OUTPUT_DIR` 环境变量改。