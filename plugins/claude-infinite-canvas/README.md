# 无限画布 Claude Code 插件

让 Claude Code 通过 MCP 服务操作无限画布（Infinite Canvas）网页画布。

## 功能

- 读取当前画布节点结构与选区
- 创建文本节点、脚本节点，连接生成流程
- 触发图片、视频、音频生成（写入操作由网页侧边栏二次确认）
- 内置 `infinite-canvas` subagent，自动使用 `mcp__infinite-canvas__*` 工具

## 安装 MCP 服务

终端执行：

```bash
claude mcp add infinite-canvas -- npx -y @tigerowo/infinite-canvas-agent mcp
```

查看已注册的服务：

```bash
claude mcp list
```

## 使用插件（可选）

```bash
claude --plugin /Users/<你的用户名>/.../plugins/claude-infinite-canvas
```

或复制插件目录到项目的 `.claude-plugin/` 与 `.mcp.json`、`.claude/agents/infinite-canvas.md` 对应位置后，在 Claude Code 中直接与无限画布对话，例如：

```text
读取当前画布并总结结构
在画布上新建一个文本节点，内容是"今日选题"
帮我基于这个选题节点生成一张配图
```

## 前提

- 需要 Node.js（用于 `npx`）
- 本地 Agent 服务需已启动（`npx -y @tigerowo/infinite-canvas-agent`），画布网页需已打开并通过 URL 参数连接（`?agentUrl=<Local URL>&agentToken=<Connect token>`）
- 连接 token 由本地 Agent 自动写入 `~/.infinite-canvas/canvas-agent.json`，MCP 进程与网页共用同一份配置