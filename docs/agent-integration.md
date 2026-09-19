# 无限画布 Agent 接入文档

无限画布（Infinite Canvas）二开版提供本地 Agent 服务（npm 包 `@huahuazi/infinite-canvas-agent`），支持以 **HTTP 服务**与 **MCP server** 两种模式运行，可被各类支持 MCP 协议的 Agent（Codex、Claude Code、Gemini CLI、Cursor 等）接入，实现“Agent 读取画布 → 规划 → 写入画布 → 网页二次确认 → 触发生成”的协作流程。

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

`agent` 随 docker-compose 一并部署在服务器上（容器 `infinite-canvas-agent`），且 Go 后端提供**同源反向代理**（`/api/agent/*`），浏览器与远程 Agent 都不需要接触 token：

- **浏览器（用户零操作）**：画布页面自动探测同源 `/api/agent/health`，探测到即自动连接，无需任何 URL 参数或 token。
- **Codex / Claude（远程一条命令接入）**：MCP 地址就是画布站点自己的同源地址，把 `<服务器地址>` 换成你平时打开画布的地址（含端口，例如 `http://1.2.3.4:3000`）：
  ```bash
  # Claude Code
  claude mcp add infinite-canvas --transport http <服务器地址>/api/agent/mcp
  # Codex（HTTP 服务器用 --url，没有 --transport 选项）
  codex mcp add infinite-canvas --url <服务器地址>/api/agent/mcp
  ```
  命令里的地址与画布页面同源，由 Go 后端反代到 agent 容器，因此外部 Agent 也不需要接触 token。
- agent 容器端口已绑定到宿主机 `127.0.0.1`，**不再对公网开放** `17371`；不要再试图用 `<服务器IP>:17371` 直连。

> 部署说明：`docker-compose.yml` 中 app 与 agent 两个服务共用 `.env` 里的同一个 `AGENT_TOKEN`，浏览器与远程 Agent 均无感。
> 反代目标由 `AGENT_PROXY_URL` 控制（默认 `http://agent:17371`，即 compose 服务名，容器网络内可直连）。

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
#    http://localhost:3000/canvas#agent=<Local URL>&token=<Connect token>
#    凭据写在 # 之后（fragment），不会进入浏览器历史、访问日志与 Referer；
#    页面读入后会立刻把 fragment 从地址栏清除。
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
- 如果 Agent 服务重启过，token 会变化，需要按新输出重新打开画布链接（刷新网页并按最新 `Local URL`/`Connect token` 重新生成 `#agent=…&token=…`）。
- MCP 进程与网页应读取同一份配置，若 token 不一致，重启各相关进程后重试。
- 也可以直接在侧边栏“服务器托管 Agent / 本地 Agent”接入面板里粘贴地址与 token 后点“连接本机 Agent”，面板会给出具体失败原因。

### 无画布连接

**现象**：工具调用成功但返回“无画布连接”或操作为空。

**排查**：

- 确认浏览器已打开画布地址，且地址栏的 `#` 后带了 `agent=<地址>` 与 `token=<token>`（粘贴后注意是否完整）。
- 确认画布与本地 Agent 服务指向同一份配置（同一用户目录）。
- 刷新画布页面重新建立连接后重试。

### 写入未生效

**现象**：Agent 报告已写入，但画布没有变化。

**排查**：

- 写入操作需在网页侧边栏二次确认，检查侧边栏是否有待确认的写入请求。
- 确认当前选中了正确的画布/画布模式（新建 `mode=new`、最近 `mode=recent`、选择 `mode=choose`）。

### 服务器托管模式返回 401

**现象**：画布页面显示“缺少连接 token / token 无效或已失效”，或者 `curl <服务器地址>/api/agent/health` 返回 `ok`，但画布就是连不上；浏览器网络面板里 `/api/agent/events`、`/api/agent/canvas/state` 返回 `401`。

**原因**：app 容器与 agent 容器没有用同一个 `AGENT_TOKEN`。app 容器读 `.env` 里的 `AGENT_TOKEN` 并把它注入 `x-canvas-agent-token` 请求头；agent 容器也读同一个变量做校验。`.env` 里没配时 agent 容器会自行随机生成 token，app 容器却注入空值，于是 `/health`（不需要鉴权）正常、`/events`（需要鉴权）401。

**排查**：

1. 检查 `.env` 里是否有非空的 `AGENT_TOKEN`，例如：
   ```bash
   grep AGENT_TOKEN .env
   ```
   没有就补一行，值用随机串（`openssl rand -hex 18` 生成）。
2. 确认 app 与 agent 两个容器读到的是同一个值：
   ```bash
   docker compose exec app printenv AGENT_TOKEN
   docker compose exec agent printenv AGENT_TOKEN
   ```
   两条输出必须完全一致且非空；改完 `.env` 需要 `docker compose up -d` 重建容器才会生效。
3. 确认反代目标正确（默认 `http://agent:17371`，容器网络内直连）：
   ```bash
   docker compose exec app printenv AGENT_PROXY_URL
   ```
4. 复查后端启动日志里是否有中文告警：
   ```bash
   docker compose logs app | grep 'Agent 反代'
   ```
   出现“未配置 AGENT_TOKEN”或“未配置 AGENT_PROXY_URL”说明 `.env` 还没配好。

**注意**：agent 容器的 `17371` 端口只绑定在宿主机 `127.0.0.1`，公网访问不到，这是预期行为；接入请始终走画布站点同源的 `<服务器地址>/api/agent/mcp`。
### 命名冲突

**现象**：`mcp add` 报重名或工具前缀混乱。

**排查**：先 `claude mcp list`（或对应 Agent 的 `mcp list`）确认已有服务名，移除旧注册后重新添加 `infinite-canvas`。