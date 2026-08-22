# 无限画布 Codex 插件

让 Codex 打开并操作无限画布（Infinite Canvas）网页画布。

## 功能

- 通过本地 Agent 服务的 MCP 接口，读取当前画布节点结构
- 创建文本节点、脚本节点，连接生成流程
- 触发图片、视频、音频生成（写入操作由网页侧边栏二次确认）
- 页面与节点内容默认使用中文

## 安装

macOS / Linux：

```bash
git clone https://github.com/tigerowo/infinite-canvas.git
cd infinite-canvas
codex plugin marketplace add "$(pwd)/plugins/codex-infinite-canvas"
codex plugin add infinite-canvas@infinite-canvas-codex  # 或安装命令返回的插件名
```

如果只想注册 MCP 服务，也可以直接使用：

```bash
codex mcp add infinite-canvas -- infinite-canvas-agent mcp
```

Windows PowerShell 将 `$(pwd)` 替换为 `$PWD`，Windows CMD 替换为 `%cd%`。

## 使用

安装后新建一个 Codex 任务，然后输入：

```text
帮我打开并连接到无限画布
```

之后 Codex 会：

1. 启动本地 Agent 服务 `infinite-canvas-agent`
2. 从启动输出读取 `Local URL` 和 `Connect token`
3. 打开画布地址 `http://localhost:3000/canvas?agentUrl=<Local URL>&agentToken=<Connect token>`
4. 通过 `canvas` 技能使用 MCP 工具操作画布

## 目录结构

```text
.codex-plugin/plugin.json   插件元数据
.mcp.json                   MCP 服务配置
skills/open-canvas/         打开画布技能
skills/canvas/              操作画布技能
```

## 前提

- 需要 Node.js（用于 `npx`）
- 无限画布前端需已部署并可通过画布地址访问（开发环境默认为 `http://localhost:3000/canvas`）