# 无限画布 Agent 接入文档

无限画布（Infinite Canvas）二开版提供本地 Agent 服务（npm 包 `@huahuazi/infinite-canvas-agent`），支持以 **HTTP 服务**与 **MCP server** 两种模式运行，可被各类支持 MCP 协议的 Agent（Codex、Claude Code、Gemini CLI、Cursor 等）接入，实现“Agent 读取画布 → 规划 → 写入画布 → 网页二次确认 → 触发生成”的协作流程。

## 服务模式

| 模式 | 命令 | 作用 |
| --- | --- | --- |
| HTTP 服务 | `infinite-canvas-agent` | 提供网页画布连接所需的 `Local URL`（默认 `http://127.0.0.1:17371`）与 `Connect token`，并把 token 写入 `~/.infinite-canvas/canvas-agent.json` |
| MCP server | `infinite-canvas-agent mcp` | 向 Agent 暴露画布操作工具 |

两种模式读取同一份本地配置，因此接入时无需手动传递 token。

## 画布能力

MCP 侧可用的核心工具：

- 读取：`get_canvas_summary`、`get_selected_nodes`、`get_node`、`get_generation_config`
- 文本：`create_text_node`、`create_primary_script_node`、`update_text_node`、`update_node`
- 结构：`delete_node`、`create_connection`、`delete_connection`、`create_group`、`arrange_nodes`
- 生成：`generate_image`、`edit_image`、`generate_video`、`generate_audio`（进度查询 `get_media_task_status`）
- 状态：`set_agent_state`

写入操作（创建/删除节点、连接、改内容、触发生成）会由网页侧边栏二次确认后生效。

## Agent 能力对比

| Agent | 安装方式 | 能力 |
| --- | --- | --- |
| Codex | 插件：`codex plugin marketplace add ~` + `codex plugin add infinite-canvas`；或 `codex mcp add infinite-canvas -- infinite-canvas-agent mcp` | 全量（线程/审批流/流式输出） |
| Claude Code | `claude mcp add infinite-canvas -- infinite-canvas-agent mcp`，可用 `.claude/agents/infinite-canvas.md` 定义 subagent | 中（流式输出 + 会话恢复） |
| Gemini CLI | `gemini mcp add infinite-canvas -- infinite-canvas-agent mcp` | 中 |
| Cursor / 其他 | 设置 → MCP → Add → 命令填 `infinite-canvas-agent mcp` | 中 |

说明：

- **Codex（全量）**：Codex 对插件内置 MCP 支持最完整，支持线程内多轮审批、审批流深度集成与流式输出，画布写入的二次确认可自然融入交互。
- **Claude Code（中）**：支持流式输出与会话恢复；写入确认以工具结果回传，不依赖审批流。
- **Gemini CLI / Cursor / 其他（中）**：具备完整工具调用能力，但画布写入的二次确认需要用户在网页侧边栏手动确认。

## 快速接入

> 首次使用前先在仓库 `agent/` 目录构建并注册本地命令（全局仅一次）：
> `cd agent && npm install && npm run build && npm link`，之后即可直接使用 `infinite-canvas-agent` 命令。

```bash
# 1. 启动本地 Agent 服务（保持运行，用于画布网页连接）
infinite-canvas-agent

# 2. 给目标 Agent 注册 MCP（以 Claude Code 为例）
claude mcp add infinite-canvas -- infinite-canvas-agent mcp

# 3. 打开画布网页（开发环境默认地址）
#    http://localhost:3000/canvas?agentUrl=<Local URL>&agentToken=<Connect token>
```

## 常见问题与排查

### 服务未启动

**现象**：工具调用超时、报连接失败。

**排查**：

```bash
curl http://127.0.0.1:17371/health
```

- 返回正常（`ok`）：本地 Agent 服务在运行，问题在画布网页侧连接。
- 无响应：服务未启动或端口被占用。重新运行 `infinite-canvas-agent`，并确认 MCP 进程是独立于 HTTP 服务的第二个进程。

### token 失效

**现象**：网页画布提示连接失败、token 无效或已失效。

**排查**：

- 确认 `~/.infinite-canvas/canvas-agent.json` 存在且包含有效 token。
- 如果 Agent 服务重启过，token 会变化，需要按新输出重新打开画布链接（刷新网页并按最新 `Local URL`/`Connect token` 重新拼接 URL）。
- MCP 进程与网页应读取同一份配置，若 token 不一致，重启各相关进程后重试。

### 无画布连接

**现象**：工具调用成功但返回“无画布连接”或操作为空。

**排查**：

- 确认浏览器已打开画布地址，且 URL 上带 `agentUrl` 与 `agentToken` 参数（粘贴后注意参数是否完整）。
- 确认画布与本地 Agent 服务指向同一份配置（同一用户目录）。
- 刷新画布页面重新建立连接后重试。

### 写入未生效

**现象**：Agent 报告已写入，但画布没有变化。

**排查**：

- 写入操作需在网页侧边栏二次确认，检查侧边栏是否有待确认的写入请求。
- 确认当前选中了正确的画布/画布模式（新建 `mode=new`、最近 `mode=recent`、选择 `mode=choose`）。

### 命名冲突

**现象**：`mcp add` 报重名或工具前缀混乱。

**排查**：先 `claude mcp list`（或对应 Agent 的 `mcp list`）确认已有服务名，移除旧注册后重新添加 `infinite-canvas`。