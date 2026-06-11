# CSV Analyze

跑在 EdgeOne Makers 上的双 Agent CSV 分析应用：上传 CSV，生成 Vega-Lite 图表与文字洞察，全程通过 SSE 推送结果。底层基于 Claude Agent SDK。

**Framework：** Claude Agent SDK · **Category：** File Processing <!-- TODO: confirm --> · **Language：** TypeScript

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=csv-analyze-agent&from=within&fromAgent=1&agentLang=typescript)

<!-- ![preview](./assets/preview.png)  TODO: confirm -->

## 概述

把一份 CSV 拖进来，输出一份能直接交付的分析报告：图表、文字洞察、可下载的 Markdown / HTML 文档。整个流程由两个 Claude Agent 通过 MCP 串起来，EdgeOne 沙箱工具负责 CSV 统计与图表渲染。可作为"Agent 读文件 + 写报告"类业务的范例。

- **双 Agent 流水线** —— Chart Agent 先做 CSV 画像并生成 3–6 张 Vega-Lite SVG；Insight Agent 读取图表元数据，输出基于具体数字的图表洞察与整体小结。
- **拖拽上传 + 编码识别** —— 自动识别 UTF-8 / GBK / UTF-16，先做列画像再启动 Agent。
- **流式可视化** —— 前端状态机（`scanning → charting → insights → report`）完全由后端的 `AgentEvent` 类型化事件驱动，用户能实时看到 Agent 的思考过程。
- **可下载报告 + 历史记录** —— 嵌入 SVG 的 Markdown / HTML 报告；分析结果通过 `context.agent.store` 持久化，按 taskId 可再次查看。
- **Demo 模式** —— 图表更少、上限更低，用于快速预览。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。可填 Makers Models 的 API Key，也可以是任意 OpenAI 兼容服务商的 Key。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关 Base URL。Makers Models 请使用 `https://ai-gateway.edgeone.link/v1`。 |
| `AI_GATEWAY_MODEL` | 否 | 模型 ID。默认 `@makers/deepseek-v4-flash`（内置免费模型）。 |

模板遵循 OpenAI 兼容协议，可以指向 Makers Models，也可以指向任意 OpenAI 兼容的服务商。

### 如何获取 `AI_GATEWAY_API_KEY`

1. 打开 [Makers 控制台](https://console.cloud.tencent.com/edgeone/makers)。
2. 登录并开通 Makers。
3. 进入 **Makers → Models → API Key**，新建一个 Key。
4. 把它粘到 `AI_GATEWAY_API_KEY`。

内置的 `@makers/deepseek-v4-flash` 免费但有用量限制，适合验证；生产建议自行绑定付费厂商（BYOK）。

### Provider fallbacks

`agents/_lib/model.ts` 在运行时把 `AI_GATEWAY_*` 映射成 Claude Agent SDK 子进程需要的 `ANTHROPIC_*`。还可设 `AI_GATEWAY_SMALL_MODEL` 覆盖 SDK 内部子调用使用的小模型。可选的 `WORK_ROOT` 用于改变上传 CSV 与生成产物的存放位置（默认 `$TMPDIR/csv-analyze-sessions`）；`SESSION_TTL_MS` 控制内存 Session 的过期时间（默认 24 小时）。

## 本地开发

前置依赖：Node.js ≥ 18，已安装 EdgeOne CLI（`npm i -g edgeone`）。

```bash
npm install
cp .env.example .env       # 然后填入 AI_GATEWAY_API_KEY / AI_GATEWAY_BASE_URL
edgeone makers dev
```

本地观测面板：`http://localhost:8080/agent-metrics`。

## 项目结构

```text
csv-analyze/
├── agents/                          # 有状态的 EdgeOne Makers Agent Functions（Node/TS）
│   ├── _lib/                       # 共享模块 —— agents、tools、sessions、events、reports
│   │   ├── analyze.ts              # 双 Agent 编排
│   │   ├── system-prompt.ts        # Chart / Insight system prompts
│   │   ├── report.ts               # Markdown / HTML 报告组装
│   │   ├── session.ts              # 内存 Map<conversationId, Session>
│   │   ├── events.ts               # AgentEvent 类型联合
│   │   └── tools/                  # MCP 工具（chart-agent、insight-agent、shared）
│   ├── upload/index.ts             # POST /upload —— 多 part CSV 上传 + 画像
│   ├── analyze/index.ts            # POST /analyze —— get | start | cancel | delete
│   ├── analyze/stream.ts           # POST /analyze/stream —— SSE 事件流
│   ├── analyze/rerun-insights.ts   # POST /analyze/rerun-insights
│   ├── analyze/download.ts         # POST /analyze/download —— 下载报告
│   ├── analyze/stop.ts             # POST /analyze/stop —— 中断当前 agent
│   └── static/index.ts             # POST /static —— 提供生成的 SVG
├── cloud-functions/                 # 无状态的 EdgeOne Makers Node Functions
│   ├── history/index.ts            # POST /history —— 按会话拉取分析记录
│   ├── history-detail/index.ts     # POST /history-detail —— 单 taskId 完整产物
│   ├── _http.ts                    # 共享 HTTP 工具
│   └── _logger.ts                  # 日志工具
├── src/                             # 前端（React + Vite + Tailwind v4）
│   ├── components/                 # DropZone、PassCard、AgentCanvas、ReportView 等
│   ├── hooks/useAgentStream.ts     # SSE 状态机
│   ├── lib/                        # API 客户端、事件类型、格式化
│   └── types.ts                    # 前端类型子集
├── package.json
├── edgeone.json                     # framework=claude-sdk，agents.timeout=300，sandbox.timeout=300
└── index.html
```

> 以 `_` 开头的文件是私有模块，不会暴露为公开路由。

## 工作原理（How It Works）

`agents/` 跑的是**会话模式**：携带相同 `Markers-Conversation-Id` HTTP Header 的请求会粘性路由到同一个 Agent 实例，从而共享同一份内存 `Session` 与同一个 EdgeOne 沙箱。这种粘性正是 `/analyze/stream`（SSE 流）与 `/analyze/stop`（中断）能命中同一个正在跑的任务的前提。

端到端流程：

1. **上传**：`POST /upload` 接收 multipart CSV，识别编码，计算列画像，返回 `taskId`。CSV 暂存于 `WORK_ROOT/<taskId>/`。
2. **启动**：`POST /analyze` 携带 `action: "start"` 在内存 Map 中注册一个 `Session`，调用 `agents/_lib/analyze.ts` 中的 `analyze()` 启动流水线。前端打开 `POST /analyze/stream` 订阅 `AgentEvent` 流。
3. **Chart Agent**：Claude（`@anthropic-ai/claude-agent-sdk` 的 `query()` + `createSdkMcpServer()`）调用自定义 MCP 工具集：`profile_csv`、`sample_rows`、`get_column_values`、`compute_correlation`、`render_chart`、`save_chart_meta`，规划 3–6 张图，渲染 Vega-Lite 为 SVG，并把 chart metadata 写回 session。
4. **Insight Agent**：第二个 Claude Agent 通过 `read_profile`、`read_chart_meta`、`read_column_stats`、`read_correlation` 读取缓存数据，再用 `save_insight` 写入图表洞察与整体小结。
5. **报告组装**：`agents/_lib/report.ts` 把 SVG + 文字洞察拼成 Markdown 与 HTML；`POST /analyze/download` 返回交付物。
6. **校验与取消**：前端任意时刻可调用 `POST /analyze/stop`，经过 `context.utils.abortActiveRun()` 真正释放上游 LLM 调用。已落地的结果在 `context.agent.store` 中，前端通过无状态的 `/history` 与 `/history-detail` 即可重新拉取，无需启动新的 agent。

沙箱凭证由运行时自动注入，无需本地配置。`edgeone.json` 中 `agents.timeout` 与 `agents.sandbox.timeout` 均为 300 秒。

## 资源

- [EdgeOne Makers Agents 文档](https://pages.edgeone.ai/document/agents)
- [EdgeOne Makers 快速开始](https://pages.edgeone.ai/document/agents-quickstart)
- [Makers Models](https://pages.edgeone.ai/document/models)

## License

MIT.
