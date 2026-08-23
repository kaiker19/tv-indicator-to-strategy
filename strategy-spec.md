# 自然语言 Strategy Spec

> 用户给的是交易想法、多指标组合或明确规则，而不是一份需要保留视觉结构的现有指标源码时，使用本流程。

## 不可跳过的状态机

1. **固定原始意图**：只读取用户描述一次，原文写入 `sourceIntent`；不要先连接 TradingView，也不要先写 Pine。
2. **写 Spec**：生成 `schemaVersion: 1` JSON 到临时目录。显式保留假设和歧义，不补猜交易规则。
3. **校验**：运行 `validate`。退出码 `2` 时，只向用户询问 `blockingAmbiguities`，一次合并提问，然后停在本步。
4. **审阅**：校验通过后，用 6 行以内展示市场、入场、过滤器、退出、仓位/执行、成本。机制建议只是备选，不自动加入规则。
5. **编译与静态检查**：运行 `compile` 写 Pine，再运行 `inspect --spec`。任何结构或静态错误都不得进入 TradingView。
6. **真实验证**：把生成的 Pine 交给既有 `auto_inject.mjs` 流程；按 `run_summary.json.nextRead` 读取证据并生成报告。

已明确的用户规则优先于历史案例和模板。不要为了少问一次而猜测 `symbol`、`timeframe`、退出、仓位、成本或执行方式；用户明确说“采用项目默认口径”时，才可采用 long-only、收盘执行、零加仓和其明确认可的成本值。

## 提问政策

- 只问 `severity: "blocking"` 的歧义；非阻塞解释写入 `assumptions[]`，随 Spec 一起展示。
- 用户已经给出的参数、市场或成本不再询问。
- 同一轮把所有阻塞问题合并，问题直接对应字段，并提供至少两个可审阅选项。
- 没有退出规则不能只生成入场代码；不知道标的不能先拿 QQQ 代跑。
- `validate` 退出码为 `0` 时继续，`2` 时等待答案，`1` 时修复结构或不支持的组件。

失败范例见 `engine/fixtures/strategy_specs/failure-ambiguous.json`。它保留缺失的市场与退出问题，且不会生成 Pine 或连接 CDP。

## Schema v1 速查

顶层必填：

| 字段 | 规则 |
|---|---|
| `title` / `summary` / `sourceIntent` | 可审阅标题、规则摘要、用户原始意图 |
| `family` | `trend` / `mean_reversion` / `breakout` / `state_switching` / `other` |
| `market` | 显式 `symbol` 与日/周/月 `timeframe`，如 `BATS:QQQ`、`1D` |
| `execution` | v1 仅支持 `bar_close`、`long_only`、`pyramiding: 0`、`processOrdersOnClose: true` |
| `costs` | `commissionPct` 为非负百分数，`slippageTicks` 为非负整数 |
| `position` | `sizePct`，范围 `(0, 100]` |
| `indicators[]` | 唯一 `id`、组件 `kind`、价格 `source`、显式 `params` |
| `entry` / `exit` | 入场主信号、可选过滤器、退出信号和可选百分比止损止盈 |
| `assumptions[]` / `ambiguities[]` | 非阻塞解释与待用户决定的规则 |

支持的指标组件：`sma`、`ema`、`rma`、`rsi`、`macd`、`bollinger`、`atr`、`highest`、`lowest`。价格源只支持 `open/high/low/close/hl2/hlc3/ohlc4`。

参数：普通组件使用 `length`；Bollinger 另有 `multiplier`；MACD 使用 `fastLength/slowLength/signalLength`。多输出引用必须写明：MACD 为 `macd/signal/hist`，Bollinger 为 `basis/upper/lower`。`highest/lowest` 编译为前序通道 `[1]`，当前 K 线不会参与自身突破门槛。

表达式支持：

- 组合：`all`、`any`、`not`。
- 比较：`crosses_above`、`crosses_below`、`greater_than`、`less_than`、`greater_or_equal`、`less_or_equal`。
- 操作数三选一：`{"indicator":"fast"}`、`{"indicator":"bands","output":"lower"}`、`{"price":"close"}`、`{"value":35}`。

`entry.filters[]` 每项必须有唯一 `id`、布尔 `enabled` 和 `condition`。关闭的过滤器留在 Spec 供审阅，但不会编译进策略。

## 规范样例

- 简单趋势策略：`engine/fixtures/strategy_specs/simple-ema-cross.json`。
- 多指标组合：`engine/fixtures/strategy_specs/complex-bollinger-rsi.json`。
- 阻塞歧义：`engine/fixtures/strategy_specs/failure-ambiguous.json`。

不要复制样例中的 QQQ、参数或成本，除非用户明确采用这些值。样例定义结构，不定义交易偏好。

## CLI

先定位技能目录：

```bash
SPEC_CLI="$SKILL_DIR/engine/strategy_spec_cli.mjs"

node "$SPEC_CLI" validate /tmp/strategy-spec.json
node "$SPEC_CLI" compile /tmp/strategy-spec.json --out /tmp/generated-strategy.pine
node "$SPEC_CLI" inspect /tmp/generated-strategy.pine --spec /tmp/strategy-spec.json
```

CLI 只向 stdout 输出紧凑 JSON，不打印完整 Pine；`compile` 必须显式传 `--out`，并且只在全部检查通过后原子写入。退出码：`0` 通过，`2` 有阻塞歧义，`1` 结构、静态或 I/O 错误。

`validate` 返回最多三条 `guidance.suggestions`。它们来自策略家族和案例结论，只用于提醒互补机制及风险；不得自动修改 Spec，也不得复制案例参数。第一版最多选择一个确有机制理由的补充条件，并重新校验。

## 不支持组件的降级

v1 不支持空头、盘中执行、加仓、任意 Pine 函数或复杂状态机。遇到这些需求时：

1. 仍先用短文本审阅市场、入场、退出、仓位、执行和成本，保留未决问题。
2. 明确告诉用户该规则超出确定性编译器范围，再人工生成 Pine 到临时文件。
3. 对人工 Pine 运行 `inspect`；静态检查通过后才可进入 TradingView 编译与证据流程。
4. 不把静态通过描述为“无重绘证明”；TradingView 编译、策略身份和回测证据仍是硬门槛。

## 报告映射

完整 JSON Spec 是生成和审计合同；报告里的 `strategySpec` 是它的简明映射。映射时保留入场、退出、仓位、执行、成本和明确排除项。`guidance` 只有被用户采纳并写入规则后，才可出现在报告的 modifiers 或信号说明中。
