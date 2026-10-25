# 无限画布 Agent 接入文档

无限画布（Infinite Canvas）二开版提供本地 Agent 服务（npm 包 `@huahuazi/infinite-canvas-agent`），支持以 **HTTP 服务**与 **MCP server** 两种模式运行，可被各类支持 MCP 协议的 Agent（Codex、Claude Code、Gemini CLI、Cursor 等）接入，实现"Agent 读取画布 → 规划 → 写入画布 → 触发生成"的协作流程。

从 v0.10 起，接入分两条通道：

| 通道 | 执行者 | 需要浏览器 | 典型场景 |
| --- | --- | --- | --- |
| 画布代理工具（`get_canvas_summary`、`create_text_node` 等） | 网页前端 | ✅ 页面必须开着 | 边聊边改，用户实时看到变化 |
| 无头画布通道（`headless_*`） | 后端 | ❌ | 批量整理、批量出图、CI、无人值守 |

## 服务模式

| 模式 | 命令 | 作用 |
| --- | --- | --- |
| HTTP 服务 | `infinite-canvas-agent` | 提供网页画布连接所需的 `Local URL`（默认 `http://127.0.0.1:17371`）与 `Connect token`，并把 token 写入 `~/.infinite-canvas/canvas-agent.json` |
| MCP server | `infinite-canvas-agent mcp` | 向 Agent 暴露画布操作工具 |

两种模式读取同一份本地配置，因此接入时无需手动传递 token。

## 两种接入形态

### 形态一：本地模式（本机运行，个人使用）

`agent` 跑在你自己电脑上，浏览器画布（无论本地还是服务器部署）通过本机 `127.0.0.1:17371` 与它通信。适合个人电脑上使用：

```bash
cd agent && npm install && npm run build && npm link   # 首次安装
infinite-canvas-agent                                    # 启动
```

### 形态二：服务器集中模式（部署跟随画布，用户零安装）

`agent` 随 docker-compose 一并部署在服务器上（容器 `infinite-canvas-agent`），且 Go 后端提供**同源反向代理**（`/api/agent/*`）：

- **浏览器**：画布页面自动探测同源 `/api/agent/health`，探测到即自动连接。
- **外部 Agent**：MCP 地址就是画布站点自己的同源地址 `<站点地址>/api/agent/mcp`。
- agent 容器的 `17371` 端口只绑定宿主机 `127.0.0.1`，**不要**用 `<服务器IP>:17371` 直连。

## 鉴权（v0.10 起）

`/api/agent/mcp` 不再匿名可用。支持两类凭据：

| 凭据 | 适用范围 | 获取方式 |
| --- | --- | --- |
| 用户 MCP token（`mcp_<userId>_<签名>`） | 外部 Agent 代表某个用户接入 | 画布侧边栏「Agent 接入」面板自动填入；或调 `GET /api/v1/agent/token` |
| 服务间密钥（`AGENT_MCP_KEY`） | agent 容器调后端 `/api/agent-canvas/*` | 服务器 `.env` |

- 用户 token 由 `HMAC-SHA256(AGENT_MCP_KEY, "infinite-canvas-agent:"+userId)` 派生，**不落库**；轮换 `AGENT_MCP_KEY` 后所有已签发 token 一起失效。
- 请求头写法：`Authorization: Bearer <token>`，或 `X-Agent-Key: <token>`，或 `?key=<token>`（不推荐，会进访问日志）。
- 浏览器专用路径（`/api/agent/events`、`/api/agent/canvas/*`）仍然走"同源 + 反代注入 token"，不受影响。

## 快速接入

最简单的方式：打开画布 → 右侧助手面板 → 「Agent 接入」区域 → 直接复制生成的命令。命令里已经带上你的 MCP token、`clientId` 与 `userId`。

手动写法（把 `<站点>`、`<token>`、`<clientId>`、`<userId>` 换成实际值）：

```bash
# Codex（HTTP MCP 只支持从环境变量读 Bearer）
export INFINITE_CANVAS_TOKEN=<token>
codex mcp add infinite-canvas \
  --url "<站点>/api/agent/mcp?clientId=<clientId>&userId=<userId>" \
  --bearer-token-env-var INFINITE_CANVAS_TOKEN

# Claude Code
claude mcp add infinite-canvas --transport http \
  "<站点>/api/agent/mcp?clientId=<clientId>&userId=<userId>" \
  --header "Authorization: Bearer <token>"

# 本地 stdio（agent 跑在自己电脑上，不需要 token）
codex mcp add infinite-canvas -- infinite-canvas-agent mcp
```

`clientId` 与 `userId` 都是可选的：

- 不带 `clientId`：工具打到"最近连接的那个浏览器"（单人使用没问题，多人会串台）。
- 不带 `userId`：无头工具不注册，只能使用画布代理工具。

## 画布代理工具

- 读取：`get_canvas_summary`、`get_selected_nodes`、`get_node`、`get_upstream_nodes`、`get_downstream_nodes`、`get_connected_nodes`、`get_generation_config`、`get_generation_task`
- 文本：`create_text_node`、`create_primary_script_node`、`update_text_node`、`update_node`
- 结构：`delete_node`、`create_connection`、`delete_connection`、`create_group`、`arrange_nodes`
- 生成：`generate_image`、`edit_image`、`generate_video`、`generate_audio`
- 进度：`get_media_task_status`
- 状态：`set_agent_state`

这些工具的执行者是网页前端：页面关掉后调用会返回「画布客户端连接已断开」。

## 无头画布通道

页面关着也能读写画布，适合批量任务：

| 工具 | 作用 |
| --- | --- |
| `headless_list_projects` | 列出画布，拿 `projectId` |
| `headless_read_graph` | 读节点与连线（长文本截断 240 字，不返回 Base64） |
| `headless_apply_ops` | 批量增删节点/连线并立即落库 |
| `headless_generate_image` | 服务端直连渠道发起图片生成，返回 `taskId` |
| `headless_task_status` | 查询任务状态与产物地址 |

`headless_apply_ops` 的 `ops` 数组支持：

```json
{"ops": [
  {"op": "add_node", "node": {"type": "text", "title": "开场白", "position": {"x": 120, "y": 80}, "metadata": {"content": "..."}}},
  {"op": "update_node", "nodeId": "node-xxx", "patch": {"title": "新标题", "metadata": {"content": "更新后的正文"}}},
  {"op": "add_connection", "fromNodeId": "node-a", "toNodeId": "node-b"},
  {"op": "remove_connection", "connectionId": "conn-xxx"},
  {"op": "remove_node", "nodeId": "node-xxx"}
]}
```

对应 REST（给不走 MCP 的场景，需要 `X-Agent-Key` + `X-User-Id`）：

| 方法 | 路径 |
| --- | --- |
| GET | `/api/agent-canvas/projects` |
| GET | `/api/agent-canvas/projects/:id/graph` |
| POST | `/api/agent-canvas/projects/:id/ops` |
| POST | `/api/agent-canvas/projects/:id/generate` |
| GET | `/api/agent-canvas/tasks/:id` |

⚠️ 无头通道直接改数据库：如果同一画布正在浏览器里打开，页面的自动保存可能覆盖结果。批量任务前先关页面。

## 多用户与多画布隔离

- 浏览器会话 ID 持久化在 `localStorage`（键 `infinite-canvas:agent-client-id`），刷新、重开标签页都不变，侧边栏可复制。
- 把 `?clientId=` 写进 MCP 地址，工具就固定打到那个浏览器，**不会被后连的人抢走**。
- 服务器集中部署且多人使用时，务必每人用自己的 `clientId` + `userId`。

## Agent 能力对比

| Agent | 安装方式 | 能力 |
| --- | --- | --- |
| Codex | `codex mcp add ... --url ... --bearer-token-env-var ...` | 全量（线程/审批流/流式输出） |
| Claude Code | `claude mcp add ... --transport http ... --header ...` | 中（流式输出 + 会话恢复） |
| Gemini CLI / Cursor | 各自 MCP 配置里填 HTTP 地址与 header | 中 |

## 常见问题与排查

### MCP 端点返回 401

**现象**：`initialize` 就 401，提示「缺少或无效的 Agent 密钥」。

**排查**：

1. 命令里是否带了 `Authorization: Bearer <token>`（Codex 需要先 `export INFINITE_CANVAS_TOKEN`）。
2. token 是否被服务端轮换过：重新打开画布，从侧边栏复制新命令。
3. 服务端是否配置了 `AGENT_MCP_KEY` / `AGENT_TOKEN`：两者都为空时端点会拒绝所有请求（启动日志有 `[Agent 鉴权]` 告警）。

### 无头工具没有注册

`tools/list` 里只有画布工具、没有 `headless_*`：说明 `userId` 缺失。给 MCP 地址加 `?userId=<你的用户ID>`，或给 agent 容器配 `CANVAS_USER_ID`。

### 服务未启动

```bash
curl http://127.0.0.1:17371/health
```

返回 `{"ok":true,...}` 说明服务在跑，问题在网页连接；无响应则是服务没起或端口被占。

### 无画布连接

- 确认浏览器已打开画布页面，且侧边栏显示"已接入"。
- 托管模式检查 `.env` 里 `AGENT_TOKEN` 是否非空、app 与 agent 两个容器是否一致：

```bash
grep AGENT_TOKEN .env
docker compose exec app printenv AGENT_TOKEN
docker compose exec agent printenv AGENT_TOKEN
```

### 写入未生效

- 用画布工具时：确认侧边栏没有待确认的写入请求。
- 用无头工具时：确认页面已关闭，否则页面自动保存会覆盖；`headless_read_graph` 里看 `updatedAt` 是否是你刚写入的值。

### 服务器托管模式返回 401

`.env` 里没有 `AGENT_TOKEN` 时，agent 容器会自行随机生成，app 容器注入空值，表现为 `/health` 正常但 `/events` 401。补齐后 `docker compose up -d` 重建容器生效。
