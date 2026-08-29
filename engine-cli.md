# 引擎 CLI

本页描述公开 Skill 的常用命令。真实回测前先按 [安装指南](SETUP.md) 启动 TradingView Desktop 并开放 CDP，再按 [公开版运行手册](public-runbook.md) 执行状态与证据门禁。

## 定位引擎

先将安装后的 Skill 目录解析为绝对路径：

```bash
SKILL_DIR="<absolute-path-to-tv-indicator-to-strategy>"
ENGINE="$SKILL_DIR/engine/auto_inject.mjs"
```

不同 Agent 的安装目录不同，不要假定产品专属变量存在。

## 安装与只读探针

```bash
cd "$SKILL_DIR/engine"
bash install.sh
node tv_probe.mjs --out /tmp/tv_probe.json
```

`npm run check` 只做本地静态检查；`npm run selftest` 会连接 TradingView 并运行捆绑 smoke strategy。Smoke 只验证自动化链路，不用于评价交易策略。

## 按名称查找公开指标

```bash
node "$SKILL_DIR/engine/resolve_indicator.mjs" "<indicator name>"
node "$SKILL_DIR/engine/resolve_indicator.mjs" "<indicator name>" --out /tmp/indicator-source.pine
node "$SKILL_DIR/engine/resolve_indicator.mjs" --id "<public-script-id>" --out /tmp/indicator-source.pine
```

返回结果必须核对名称、作者、来源和源码状态。同名实现不自动混用；没有公开源码时停止源码级结论。

## Strategy Spec

自然语言或多指标规则先走纯本地校验，不连接 TradingView：

```bash
SPEC_CLI="$SKILL_DIR/engine/strategy_spec_cli.mjs"
node "$SPEC_CLI" validate /tmp/strategy-spec.json
node "$SPEC_CLI" compile /tmp/strategy-spec.json --out /tmp/generated-strategy.pine
node "$SPEC_CLI" inspect /tmp/generated-strategy.pine --spec /tmp/strategy-spec.json
```

- 退出码 `0`：通过；
- 退出码 `2`：存在需要用户决定的阻塞歧义；
- 退出码 `1`：结构、静态或 I/O 错误。

`compile` 必须显式传 `--out`。不支持的组件先审阅规则，再人工写 Pine 并运行 `inspect`，不得用近似规则替代。

## 单次真实回测

```bash
node "$ENGINE" /tmp/strategy.pine \
  --symbol NASDAQ:QQQ \
  --timeframe D \
  --chart-layout "研究专用" \
  --commission 0.15 \
  --slippage 2
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--symbol EXCHANGE:TICKER` | 单市场；不传时使用当前图表 |
| `--symbols A,B,C` | 同一源码和输入依次验证多个市场 |
| `--timeframe D` | 切换周期，如 `D`、`60`、`240`、`W` |
| `--chart-layout "名称"` | 注入前精确切换本机已保存的干净布局；找不到即停止 |
| `--input "Title=value"` | 覆盖 Pine input，可重复 |
| `--commission 0.15` | 手续费百分数 |
| `--slippage 2` | 滑点 ticks |
| `--reuse` | 仅在策略名与源码摘要一致时复用当前脚本 |
| `--cleanup` | 运行后移除策略；默认保留以便用户核对 |

`--input` 的键使用 Pine `input.*` 的标题，不使用 TradingView 内部字段名。若运行时更新 input 需要重新注入，引擎会失败关闭；随后应固化默认值并重新注入，不能沿用旧指标值。

`--chart-layout` 是设备本地选项，公开 Skill 不预设名称。若切换时存在未保存修改，引擎停止且不会自动舍弃。若没有专用布局可省略，但最终 proof 必须只显示目标策略、Strategy Tester 和必要价格图；引擎不会为了清理截图自动删除用户已有指标。

## 轻量扫描

```bash
node "$ENGINE" /tmp/strategy.pine \
  --symbol NASDAQ:QQQ \
  --timeframe D \
  --scan "ATR Length=7..21:7" \
  --scan "Factor=1..3:1" \
  --objective risk_adjusted \
  --commission 0.15 \
  --slippage 2 \
  --budget 9
```

`--scan` 可重复，组合为笛卡尔积；`--budget` 是本次完整回测数的硬上限。扫描结果写入 `scan_results.jsonl`，摘要只返回 Top-K 和评估状态。

## 详细有界优化

用户明确要求详细研究或尽可能寻找更优参数时使用 `--optimize`：

```bash
node "$ENGINE" /tmp/strategy.pine \
  --symbols NASDAQ:QQQ,AMEX:SPY,SSE:510300 \
  --timeframe D \
  --optimize "ATR Length=5..30:5" \
  --optimize "Factor=1..5:0.5" \
  --objective risk_adjusted \
  --commission 0.15 \
  --slippage 2 \
  --budget 30
```

优化先在第一个市场做有预算的宽搜；只有形状和预算允许时才围绕本次 Top-1 检查相邻值。随后用固定 Top-1 参数验证其余市场，并恢复第一个市场与 Top-1 状态后生成 proof。

可用目标：

- `risk_adjusted`：策略收益相对最大回撤，默认；
- `net_pnl`：策略净收益；
- `profit_factor`：PF；
- `alpha`：策略收益减同次读取的 B&H，只在区间可比时有效；
- `win_rate_confidence`：按胜率置信下界排序，降低极少交易的假高胜率。

`--auto-tune "Name=min..max"` 提供单轴粗到细搜索。多参数与参数高原研究优先使用显式 `--optimize`，让范围和预算可审阅。

参数选择、停止条件与报告措辞见 [调参约定](tuning.md)。

## 输出与完成门禁

默认输出目录为 `~/.tv-skill/`；可以用 `TV_SKILL_OUTPUT_DIR` 指向独立运行目录。主要产物：

- `run_summary.json`：Agent 首先读取的紧凑结果；
- `run_manifest.json`：阶段历史和诊断；
- `scan_results.jsonl`：逐组合数据；
- `optimization.json`：有界优化、形状和多市场验证；
- `heatmap.json`：两轴时为完整网格；三轴及以上仅在 Top-1 固定切片具有二维邻域时生成，并记录总搜索维数与固定参数；
- `inject_proof.png`：恢复最终状态后的证据截图。

若传入 `--chart-layout`，`run_manifest.json.stages.chart_layout` 会记录请求名称、实际布局、布局 ID、加载后的 symbol 与周期，供截图来源审计。

只有同时满足以下条件才可生成完成报告：

```text
run_summary.status = complete
run_summary.proof.ok = true
run_summary.nextRead.action = generate_report
```

正常路径只读 `run_summary.json`；仅在 `nextRead` 指向诊断时再读取 manifest、probe 或其他产物。

## 报告

准备符合 `engine/report_data.example.json` 结构的 JSON，并运行：

```bash
node "$SKILL_DIR/engine/report.mjs" /tmp/report-data.json --check
node "$SKILL_DIR/engine/report.mjs" /tmp/report-data.json
```

报告 JSON 中的 symbol、timeframe、范围、成本、参数和 metrics 必须来自同一次运行。Agent 只填写 JSON；HTML、CSS、栏目顺序和交互全部交给 `report.mjs` 的固定模板，禁止手写页面或复用旧 HTML。完整案例固定展示 QQQ、SPY、510300；外层案例卡直接读取报告内嵌的 `case-summary`，不维护第二份手工摘要。Strategy Spec 用 `observation` 明确策略实际计算和观察的中枢、边界或状态，不能只写入场、出场；可见文案只写“按收盘价执行”“不重复加仓”等交易语义，不显示 Pine 实现标志。指标建立在普通读者可能不知道的基础概念上时，用 `explain.readerGuide[]` 按“普通概念 → 专业名称 → 实际作用”解释后再进入 Strategy Spec；专有名词必须在第一次可见正文出现时定义，并尽量给抽象参数一个数值锚点。外层概述、基础概念、精确规则、必要的状态顺序和参数场景各写一次；相邻块只是在换词复述时删掉较泛的一段，`readerGuide` 已足够时可省略 `howItWorks`，Strategy Spec 已清楚表达简单交易顺序时省略 `flow`。可见文案使用直接肯定句，避免“这不是……而是……”“只负责……”等公式化转折。公式优先使用 `explain.deep.equations[]`；每式列出的 `symbols[]` 必须在 `deep.variables[]` 逐一定义，并提供含 3–6 个简化数值、完整写出代入与中间结果的 `deep.example`，否则报告校验失败。核函数、距离函数或平滑器可替换时，要说明本次源码固定实现与替换后的复验要求。proof 必须看得见指标的核心结构且不含无关 study；通道类截图必须辨认中线、上轨和下轨。参数排名先写搜索市场和周期，可见列只保留参数、策略收益、PF 和交易数，B&H 与证据源继续保存在 JSON 中供审计。生成页带有 `tv-indicator-report-template` 版本标记；批量发布时所有页面必须使用同一版本。

## 常见失败

| 现象 | 处理 |
| --- | --- |
| CDP 无法连接 | 确认 Desktop、端口和实例，再运行探针 |
| 找不到 Pine Editor 或 Strategy Tester | 保存可见状态，停止旧坐标点击 |
| 编译失败 | 修复 Pine；不通过重复应用掩盖错误 |
| 无交易 | 核对日期、信号、方向和输入；确认后作为有效结果 |
| B&H 漂移 | 标记比较不可兼容，统一区间后重跑 |
| proof 与最终参数不一致 | 恢复市场和 Top-1 后重新读取 |
| input 更新要求重新注入 | 固化本次默认值后重新注入 |

更完整的决策树见 [公开版排错指南](public-debugging.md)。
