# Pine Script v6 参考资料

> 仅作引用查阅，转换前后若遇到语法疑问请通过 WebFetch 取最新内容。

## 官方文档
- 语言参考手册：https://www.tradingview.com/pine-script-reference/v6/
- 用户手册首页：https://www.tradingview.com/pine-script-docs/welcome/
- 策略概念页（strategy / entry / exit / close）：https://www.tradingview.com/pine-script-docs/concepts/strategies/
- 输入参数（input.int / float / string / bool）：https://www.tradingview.com/pine-script-docs/concepts/inputs/
- v5 → v6 迁移指南：https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-6/
- 指标转策略 FAQ：https://www.tradingview.com/pine-script-docs/faq/strategies/

## 关键函数锚点（拼接到 reference URL 后）
- `#fun_strategy.entry`
- `#fun_strategy.exit`
- `#fun_strategy.close`
- `#fun_input.int` / `#fun_input.float` / `#fun_input.string` / `#fun_input.bool`
- `#fun_ta.crossover` / `#fun_ta.crossunder`

## 现有相关实现（参考但不依赖）
- TradersPost/pinescript-agents — Claude Code Skills 格式的 Pine 开发套件，含 pine-backtester（在 Pine 内输出 Sharpe/回撤等）
- tradesdontlie/tradingview-mcp — 通过 CDP 连接 TradingView Desktop 的 MCP，含 pine_set_source、replay 系列工具
- praveens1234/pine-mcp — Playwright 持久化 profile 调用 TradingView 官方编译器做语法校验
