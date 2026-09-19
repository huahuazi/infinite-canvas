# 无限画布通用 MCP 接入

无限画布（Infinite Canvas）的本地 Agent 服务同时提供两种能力：

- **HTTP 服务**（默认模式）：`infinite-canvas-agent`，提供网页画布连接所需地址与 token
- **MCP server**：`infinite-canvas-agent mcp`，向 Agent 暴露画布操作工具

任何支持 MCP 协议的 Agent（Codex、Claude Code、Gemini CLI、Cursor 等）都可以通过同一命令接入：

```bash
infinite-canvas-agent mcp
```

## 服务器托管模式：一条命令接入

画布按 `docker-compose.yml` 部署时，agent 与画布同源托管，浏览器零配置；外部 Agent 也只需要画布站点自己的地址（把 `<服务器地址>` 换成你打开画布的地址，含端口）：

```bash
# Claude Code
claude mcp add infinite-canvas --transport http <服务器地址>/api/agent/mcp
# Codex（HTTP 服务器用 --url，没有 --transport 选项）
codex mcp add infinite-canvas --url <服务器地址>/api/agent/mcp
```

`/api/agent/mcp` 由 Go 后端同源反代到 agent 容器，因此这条命令不需要 token。agent 容器的 `17371` 端口只绑定宿主机 `127.0.0.1`，不对外网开放，不要用 `<服务器IP>:17371` 直连。

## MCP 工具

接入后在 Agent 侧可用的工具名如下（不同 Agent 前缀规则不同，规则见下表）：

- 读取：`get_canvas_summary`、`get_selected_nodes`、`get_node`、`get_upstream_nodes`、`get_downstream_nodes`、`get_connected_nodes`、`get_generation_config`、`get_generation_task`、`get_media_task_status`
- 状态：`set_agent_state`
- 文本：`create_text_node`、`create_primary_script_node`、`update_text_node`、`update_node`
- 结构：`delete_node`、`create_connection`、`delete_connection`、`create_group`、`arrange_nodes`
- 生成：`generate_image`、`edit_image`、`generate_video`、`generate_audio`

## 各 Agent 注册命令示例

| Agent | 注册命令 | 工具前缀 |
| --- | --- | --- |
| Codex | `codex mcp add infinite-canvas -- infinite-canvas-agent mcp` | 直接为 `name`（如 `infinite-canvas_get_canvas_summary`）或无前缀 |
| Claude Code | `claude mcp add infinite-canvas -- infinite-canvas-agent mcp` | `mcp__infinite-canvas__get_canvas_summary` |
| Gemini CLI | `gemini mcp add infinite-canvas -- infinite-canvas-agent mcp` | `mcp__infinite-canvas__get_canvas_summary` |
| Cursor | 设置 → MCP → Add → 选择 `command` 类型，填 `infinite-canvas-agent mcp` | `mcp__infinite-canvas__get_canvas_summary` |
| 其他支持 MCP 的 Agent | 使用各自 `mcp add`（或 `mcp --connect`）命令，命令体固定为 `infinite-canvas-agent mcp` | 见各 Agent 文档 |

## 注意事项

1. **服务需先启动**：MCP 进程只提供画布工具，不提供网页连接服务。画布网页要能实际连接，需要先单独启动本地 Agent 服务并保持运行：
   ```bash
   infinite-canvas-agent
   ```
   然后在画布地址的 `#` 后追加 `agent=<Local URL>&token=<Connect token>`（fragment 不进入访问日志与 Referer，页面读入后立即清除）；也可以直接在画布助手侧边栏的接入面板里粘贴地址与 token 后点“连接本机 Agent”。

2. **token 自动读取**：本地 Agent 启动后会自动把连接令牌写入 `~/.infinite-canvas/canvas-agent.json`。MCP 进程与网页读取同一份配置，因此无需手动配置 token。

3. **写入二次确认**：创建、更新、删除节点及触发生成等写入操作，会由网页侧边栏进行二次确认，Agent 只需按工具返回结果继续推进。

4. **默认中文**：页面文案与画布节点内容默认使用中文。

5. **命名冲突**：如已注册过同名 `infinite-canvas` MCP server，先用 `mcp list`/`mcp remove` 清理后再添加。

## 排查

- 工具调用超时或失败：确认本地 Agent 服务仍在运行（`curl http://127.0.0.1:17371/health` 应返回 `ok`）。
- 提示“无画布连接”：确认网页画布已打开，且地址栏 `#` 后带正确的 `agent=<地址>` 与 `token=<token>`。
- **托管模式下 `/health` 返回 `ok` 但画布连不上、`/api/agent/events` 返回 401**：说明 app 容器与 agent 容器没共用同一个 `AGENT_TOKEN`。在部署目录检查并补齐 `.env`：
  ```bash
  grep AGENT_TOKEN .env                            # 需非空，值用 openssl rand -hex 18 生成
  docker compose exec app printenv AGENT_TOKEN
  docker compose exec agent printenv AGENT_TOKEN   # 两条输出必须完全一致
  docker compose logs app | grep 'Agent 反代'       # 后端启动时的中文告警
  ```
  改完 `.env` 后 `docker compose up -d` 重建容器才生效；反代目标默认 `http://agent:17371`，可用 `AGENT_PROXY_URL` 覆盖。