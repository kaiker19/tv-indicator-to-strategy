# TradingView Indicator to Strategy

把 TradingView 指标研究清楚，转换成可审阅的 Pine strategy，再获取真实 Strategy Tester 结果并生成学习页。

## Install

```bash
npx skills add kaiker19/tv-indicator-to-strategy -g
```

指定安装到 Codex、Claude Code 和 OpenClaw：

```bash
npx skills add kaiker19/tv-indicator-to-strategy -g \
  -a codex -a claude-code -a openclaw
```

使用 CDP 自动回测前，在安装后的 Skill 目录运行：

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

| 任务 | 执行方式 |
| --- | --- |
| 指标解释、重绘审计、Pine 转换 | 直接使用 Skill，无需启动 TradingView 或安装引擎依赖 |
| 打开编辑器、切换面板、处理弹窗、截图 | Agent 已有 Computer Use 时优先使用原生能力 |
| 批量改参、结构化读数、结果一致性校验 | 使用 CDP 引擎，需要 Node.js 18+ 和已登录的 TradingView Desktop |

两种执行方式共用研究规则和报告模板。当前批量回测与完成证明仍由 CDP 引擎生成，配置见 [SETUP.md](SETUP.md)。

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

## Development

```bash
cd engine
npm ci --ignore-scripts
npm test
npm run check
```

测试使用随包示例，覆盖策略编译、成本、重绘风险、收益口径和证据门禁，无需登录 TradingView。完整链路验证另用 `npm run selftest`，它会操作本机图表。

## License & community

[MIT](LICENSE)。链接认可 [LINUX DO](https://linux.do/) 社区，欢迎佬友交流与反馈。
