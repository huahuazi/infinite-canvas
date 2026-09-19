---
name: open-canvas
description: 打开无限画布（Infinite Canvas）网页画布，并自动连接本地 Agent 服务。用户要求打开、启动、进入或使用无限画布时使用。
---

# 打开无限画布

## 启动本地 Agent 服务

在终端启动本地 Agent 服务并保持运行：

```bash
infinite-canvas-agent
```

## 读取连接信息

从启动输出中读取两段信息：

- `Local URL`：本地连接地址（形如 `http://127.0.0.1:17371`）
- `Connect token`：连接令牌

## 打开画布

在浏览器中打开本仓库部署后的画布地址（开发环境默认 `http://localhost:3000/canvas`），并把连接凭据写在 URL 的 `#` 之后（fragment）：

```text
http://localhost:3000/canvas#agent=<Local URL>&token=<Connect token>
```

即：

```text
http://localhost:3000/canvas#agent=http://127.0.0.1:17371&token=<Connect token>
```

凭据必须放在 `#` 之后：fragment 不会进入服务器访问日志、Referer 与浏览器历史；页面读入凭据后会把 fragment 从地址栏立即清除，因此刷新不会重复携带，也不会残留在用户可复制的地址里。

## 使用模式

画布选择模式是普通查询参数，必须写在 `#` 之前（否则会被当成 fragment 内容而失效）：

- 新建画布：`?mode=new#agent=<Local URL>&token=<Connect token>`
- 最近画布：`?mode=recent#agent=<Local URL>&token=<Connect token>`
- 自己选择：`?mode=choose#agent=<Local URL>&token=<Connect token>`

## 说明

- MCP 进程（`infinite-canvas-agent mcp`）提供画布操作工具，本身不提供网页连接服务。
- 上面启动的本地 Agent 服务负责提供 `Local URL` 和 `Connect token`，两个进程读取同一份本地配置（`~/.infinite-canvas/canvas-agent.json`），因此连接信息可由 Agent 自行从命令输出中获取，不需要用户手动填写。
- 打开失败时，优先检查本地 Agent 服务是否仍在运行，必要时重新启动后重试。