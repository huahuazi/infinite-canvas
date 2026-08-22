---
name: open-canvas
description: 打开无限画布（Infinite Canvas）网页画布，并自动连接本地 Agent 服务。用户要求打开、启动、进入或使用无限画布时使用。
---

# 打开无限画布

## 启动本地 Agent 服务

在终端启动本地 Agent 服务并保持运行：

```bash
npx -y @huahuazi/infinite-canvas-agent
```

## 读取连接信息

从启动输出中读取两段信息：

- `Local URL`：本地连接地址（形如 `http://127.0.0.1:17371`）
- `Connect token`：连接令牌

## 打开画布

在浏览器中打开本仓库部署后的画布地址（开发环境默认 `http://localhost:3000/canvas`），并在 URL 上追加以下参数：

```text
http://localhost:3000/canvas?agentUrl=<Local URL>&agentToken=<Connect token>
```

即：

```text
http://localhost:3000/canvas?agentUrl=http://127.0.0.1:17371&agentToken=<Connect token>
```

## 使用模式

用户没有明确指定打开方式时，使用新建画布：

- 新建画布：在画布地址上追加 `&mode=new`
- 最近画布：`&mode=recent`
- 自己选择：`&mode=choose`

## 说明

- MCP 进程（`npx -y @huahuazi/infinite-canvas-agent mcp`）提供画布操作工具，本身不提供网页连接服务。
- 上面启动的本地 Agent 服务负责提供 `Local URL` 和 `Connect token`，两个进程读取同一份本地配置（`~/.infinite-canvas/canvas-agent.json`），因此连接信息可由 Agent 自行从命令输出中获取，不需要用户手动填写。
- 打开失败时，优先检查本地 Agent 服务是否仍在运行，必要时重新启动后重试。