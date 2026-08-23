# TradingView Indicator to Strategy

把 TradingView 指标研究清楚，转换成可审阅的 Pine strategy，并通过用户本机已登录的 TradingView Desktop 获取真实 Strategy Tester 结果。

## Install

```bash
npx skills add kaiker19/tv-indicator-to-strategy -g
```

指定安装到 Codex、Claude Code 和 OpenClaw：

```bash
npx skills add kaiker19/tv-indicator-to-strategy -g \
  -a codex -a claude-code -a openclaw
```

首次使用真实回测能力时，在安装后的 Skill 目录运行：

```bash
bash engine/install.sh
```

## Use

把指标准确名称与作者、TradingView 链接、Pine 源码、图表截图或自然语言规则交给 Agent。例如：

> 研究这个指标，检查重绘并整理成 Strategy Spec；连接我的 TradingView，在 QQQ、SPY、510300 日线上用同一参数做真实回测，完成有界参数研究并生成 HTML 报告。

Skill 会依次完成：

1. 核对指标身份、公开源码与版本；
2. 解释信号、参数、确认时点和失效环境；
3. 审计重绘、未来数据和执行歧义；
4. 生成并校验 Pine v6 strategy；
5. 在 TradingView Strategy Tester 中运行基线、参数研究和三市场复核；
6. 输出包含收益、B&H、回撤、PF、交易数和证据状态的自包含 HTML。

只做指标理解时不需要连接 TradingView。真实回测需要 Node.js 18+、已登录的 TradingView Desktop 和可用的 CDP 端口，参见 [SETUP.md](SETUP.md)。

## Research defaults

- 参数研究使用统一的执行预算，不区分“轻度”或“深化”模式；
- 30 组以内完整覆盖，更大网格默认做 30 次均匀粗搜与有效邻域复核；
- 默认排名目标是净收益 ÷ 最大回撤，不是 PF；
- Top-1 仍需检查交易数、参数邻域、B&H 口径和 QQQ、SPY、510300 同参数结果；
- 结果只代表本次参数空间，不声称全局最优。

详细规则见 [SKILL.md](SKILL.md)、[运行手册](public-runbook.md)和[参数研究约定](tuning.md)。

## Boundaries

Skill 不自动下单，也不会在缺少真实 TradingView 证据时编造收益、胜率、PF、回撤或最优参数。公开包不附带 QQQ、SPY、510300 的历史行情库；真实指标绩效由用户本机已登录的 TradingView 现场计算。公开仓库也不包含用户源码、账户状态、Cookie、令牌、运行截图或私有研究资料。

内容仅供研究，不构成投资建议。
