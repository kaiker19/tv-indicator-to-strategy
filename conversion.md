# 转换规则（indicator → v6 strategy）

> SKILL.md 的「转换」步细节。把指标转成可回测策略时照此做。

## 先分流：现有指标还是自然语言策略

- **已有指标源码**：继续按本文件 Step 1-6 转换，尽量保留原计算与视觉结构。
- **自然语言策略或多指标组合**：先按 [strategy-spec.md](strategy-spec.md) 生成并校验 `Strategy Spec v1`，由确定性编译器生成简洁 Pine；不要套用本文件“保留所有 plot”的要求。
- **Spec v1 不支持的组件**：先完成同样的规则审阅，再人工写 Pine 并运行 `strategy_spec_cli.mjs inspect`。不得用相似指标静默替代。

两条路径最终都进入同一个 `auto_inject.mjs` 证据流程。确定性编译器当前只支持 long-only、收盘执行、零加仓；已有指标人工转换路径仍按用户明确规则处理，但必须写清差异。

## Step 1.0：先查经典策略库

先看 `engine/strategies/classic.mjs`，必要时用 `matchStrategy(indicatorText)` 排候选。命中经典形态时，优先沿用库里的入场/出场逻辑、典型参数范围、适用/失效场景和 Pine v6 skeleton，再结合源码做最小调整。

## Step 1：识别指标类型

根据代码结构判断指标类型。下表只给出**简单、可审阅的基线候选**，不是看到类型就必须套用的最终策略：

| 类型 | 识别特征 | 基线候选 |
|------|----------|----------|
| **振荡器（Oscillator）** | 输出值域 0-100，有 hline(30/70) 或 hline(20/80) | 超卖区上穿做多，超买区下穿平仓 |
| **趋势跟踪（MA/EMA/趋势线）** | plot 出现两条均线，或价格与均线比较 | 快线上穿慢线做多，下穿做空或平仓 |
| **MACD** | macd/signal/hist 变量 | macd 上穿 signal 做多，下穿做空 |
| **布林带（Bollinger Bands）** | basis/upper/lower | 价格上穿 lower 做多，下穿 upper 平仓 |
| **自定义信号** | 有明确 buy/sell/signal 变量 | 直接使用该变量作为信号 |

> 注意：有的"指标"其实是多工具盘面（如 TMA Overlay = 多条 SMMA + 形态 + 时段），没有单一信号。
> 这时必须**选一个可交易的核心**（最能调、最贴主干的那个），并明确告诉用户这是设计选择 + 备选信号。

### Step 1.1：按角色生成少量策略假设

先判断源码中的计算分别承担什么角色：**位置**（通道/偏离）、**方向**（趋势/斜率）、**动量**（RSI/MACD）、**波动**（ATR/带宽）或**记忆**（上次退出/候选状态）。再据此选择一个核心假设；最多保留一个有明确互补价值的备选，不要把所有变量堆进入场条件。

- 通道既可能做均值回归，也可能在上升环境做趋势回踩；突破型通道则是第三种不同假设。根据源码语义和 J8 的 edge 判断，不能只因出现 `upper/lower` 就固定选均值回归。
- 只有源码已经含趋势/状态变量、多类独立入口，或用户明确要求时，才考虑状态分流。普通单信号指标仍使用上表基线，不凭空增加状态机。
- 若存在多类入口，记录本次交易的**入场来源**；只有风险形态确实不同才分配不同退出，并写清退出优先级。不要用同一根 K 线多个重叠布尔值含糊表示来源。
- 新增但非原指标必需的趋势确认、成交量确认或状态分流必须是默认关闭的 `modifiers[]`，先让用户看见简单基线。

可迁移的是“指标角色 → 市场状态（若有）→ 入场类型 → 对应退出”的设计过程，不是任何一份复杂策略的具体角度、RSI 阈值、通道分位或均线周期。

## Step 2：转换 declaration

**必须单行写完，title 用位置参数（验证过：多行 + 全命名参数会触发 TV 编译器的 "Failed to fetch" 错误）**：

```pine
strategy("XXX Strategy", overlay=<保持原值>, default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=10000, commission_type=strategy.commission.percent, commission_value=0.1)
```

- 若原 indicator 有 `overlay=true`，strategy 也用 `overlay=true`
- 若原 indicator 没有 overlay（默认 false，独立面板），strategy 也不加
- **不要写 `shorttitle=`；显式写 `pyramiding=0`** —— 项目静态门禁要求策略明确禁止同向叠加，避免转换后意外改变仓位语义
- 用户或原策略已给出真实手续费/滑点时优先保留该口径；更高成本另做压力测试并明确标注，不能静默覆盖成模板值。

## Step 3：保留所有原始计算逻辑

- 完整保留所有 input、计算变量、函数定义
- 将 `input()` 升级为对应的 `input.int()` / `input.float()` / `input.bool()`（Pine v6 要求）
- 保留所有 `plot()`、`hline()`、`fill()` 用于可视化

## Step 4：新增策略参数

在原有 input 之后添加用户可调节的策略控制参数：
```pine
// ── 策略参数 ──────────────────────────────────────
tradeDirection = input.string("Long Only", "交易方向", options=["Long Only", "Short Only", "Both"])
```

根据指标类型还需添加：
- 振荡器：`overbought`、`oversold` 阈值 input
- 均线：无需额外参数
- 止损止盈（可选）：`slPct`、`tpPct`

## Step 5：编写入场/出场逻辑

**振荡器模板（以 osc 代表主指标值）：**
```pine
longEntry  = ta.crossover(osc, oversold)
longExit   = ta.crossunder(osc, overbought)
shortEntry = ta.crossunder(osc, overbought)
shortExit  = ta.crossover(osc, oversold)

if tradeDirection != "Short Only"
    if longEntry
        strategy.entry("Long", strategy.long)
    if longExit
        strategy.close("Long")

if tradeDirection != "Long Only"
    if shortEntry
        strategy.entry("Short", strategy.short)
    if shortExit
        strategy.close("Short")
```

**均线交叉模板（fast/slow 代表两条均线）：**
```pine
longEntry  = ta.crossover(fast, slow)
shortEntry = ta.crossunder(fast, slow)

if tradeDirection != "Short Only"
    strategy.entry("Long", strategy.long, when=longEntry)
if tradeDirection != "Long Only"
    strategy.entry("Short", strategy.short, when=shortEntry)
```

## Step 6：可选止损止盈

若用户要求加止损止盈，在 entry 之后添加：
```pine
if strategy.position_size > 0
    strategy.exit("Long Exit", "Long",
                  stop=strategy.position_avg_price * (1 - slPct/100),
                  limit=strategy.position_avg_price * (1 + tpPct/100))
```

## 输出格式

输出完整的 Pine v6 策略代码，代码块之后附一段简短说明：
1. **识别到的指标类型**
2. **入场逻辑**（一句话）
3. **出场逻辑**（一句话）

同时生成可审阅的规则。自然语言路径保留完整 `Strategy Spec v1` JSON；报告中的 `strategySpec` 是其简明映射，至少记录 `entry`、`exit`、`position`、`execution`、`costs`、`exclusions`。策略转换时新增、且默认不启用的确认条件写入 `modifiers[]`，并明确 `default`、`rule`、`role`；不要把它混写成原指标必需规则。对应操作流程不靠回测截图保存，而由 Strategy Spec + `explain.flow[]` 留存，回测结果只作为这套规则的一次验证证据。

## 注意事项

- Pine v6 中 `input()` 已弃用，必须用具体类型的 input 函数
- `strategy()` 中的 `overlay` 参数必须与原 indicator 保持一致，否则会显示错误
- 保持原有变量名不变，只在末尾追加策略逻辑，减少出错风险
- 若指标逻辑复杂无法自动推导信号，输出代码并在注释中标注需要用户手动指定信号位置

## 经过验证的"安全模式"（重要，违反会触发 Failed to fetch / 编译错误）

1. **`strategy(...)` 必须单行**，title 用位置参数（不要写成多行 + 全命名参数）
2. **不要在 `plot/hline` 里直接用 hex 字面量**，用 `color.blue` / `color.gray` / `color.red` 等命名值；要透明度用 `color.new(color.gray, 50)`
3. **不要用 `fill(hline1, hline2, ...)`**：v6 中 `hline` 返回值传入 `fill` 易报错。可视化阈值线只用单纯的 `hline()` 即可，省略背景填充
4. **`if` 条件加括号**：`if (longEntry)` 而不是 `if longEntry`，更稳定
5. **input 描述用英文**：避免中文字符串配合 `options=[...]` 数组参数时出现编码相关解析问题

详细 Pine v6 文档链接见 [references.md](references.md)。
