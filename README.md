<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="https://github.com/huahuazi/infinite-canvas"><img src="https://img.shields.io/github/stars/huahuazi/infinite-canvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="VERSION"><img src="https://img.shields.io/badge/version-v0.6.4-2563eb?style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Docker ready"></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16.2-000000?style=flat-square&logo=nextdotjs" alt="Next.js"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.25-00add8?style=flat-square&logo=go&logoColor=white" alt="Go"></a>
</p>

无限画布是一款面向图片、视频、音频的全能 AI 创作开源工作台。它把无限画布编排、AI 生图 / 生视频 / 生音频、参考图编辑、3D 导演台、全景图、画布 Agent、提示词库和素材沉淀放在同一个界面里，适合用来探索视觉方案并连续迭代图片结果。

本项目由 [basketikun(纯前端)](https://github.com/basketikun/infinite-canvas) 的无限画布演进而来，在保持画布创作体验的基础上，补齐了账号体系、云端同步、管理后台与本地 Agent 能力，形成一套可独立部署、多人使用的 AI 创作平台。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种数据库结构和存储格式都可能直接调整。
>
> 二次开发与 PR 请保留原作者信息。

## 核心功能

- **无限画布**：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出
- **AI 创作**：支持 OpenAI 兼容接口的 Images API、Responses API、图生图、参考图编辑、流式接收、Base64 图片返回；Seedance 2.0 可通过火山方舟 Agent Plan 接入；同时支持 Gemini、MiniMax H3、Grok TTS 等渠道
- **全景图**：支持文字生成、参考图生成和本地 2:1 全景图导入，可作为导演台的场景环境背景
- **3D 导演台**：在独立 3D 场景中布置角色、模型、全景环境和机位，支持关键帧、时间轴、镜头管理、截图与 MP4 导出，并将机位画面自动发送为连线图片节点
- **摄像机控制**：图片、视频和生成配置节点支持独立设置相机、镜头、焦距和光圈，将镜头参数自动写入生成提示词，并随节点保存和复制
- **账号与云端同步**：画布、素材、生成记录和媒体文件可迁移到云端，多设备按时间戳合并；支持管理后台（渠道、AI 调用日志、提示词、素材管理）
- **生图工作台**：支持侧边/悬浮底部工作台、多任务并发、历史结果合并展示、分类管理、失败详情与参考图缩略图
- **创作工作流**：支持公开/个人模板、变量表单、AI 创建工作流、单图/多图系列工作流
- **画布助手**：围绕选中节点和上游节点对话、生图，并把结果插回画布
- **画布助手模型/渠道选择（新增）**：对话、图片、视频、音频四类模型分别在画布助手内选择渠道与模型（读取已配置的云端/本地渠道，按能力自动过滤），只作用于当前画布 Agent 会话，不影响全局配置
- **画布交互增强（新增）**：拖拽节点智能吸附对齐线（8px 阈值 + 蓝色参考线），图片视口外懒加载，多节点同屏更流畅
- **工作流 ↔ 画布打通（新增）**：创作工作流运行结果一键批量落回画布，支持从画布导入图片节点作为参考图，VTO 批量出图全链路
- **批量变量注入（新增）**：变量用 `|` 分隔多值，自动笛卡尔积展开批量生成（如 产品名=头饰A|头饰B 生成多张变体图）
- **本地 Agent（本次二开新增）**：通过本地 `canvas-agent` 服务把画布连接到 Codex、Claude Code、Gemini 等任意 Agent，Agent 通过 MCP 工具读取节点、创建节点、整理流程并触发生成
- **生成参数增强（本次二开新增）**：透明背景、Reasoning Effort、自定义调用脚本，灵活适配各类中转站与自建服务
- **插件化 Agent 接入（本次二开新增）**：提供 Codex / Claude Code / 通用 MCP 三套安装包，一行命令接入

完整功能说明见 [docs/overview/features.md](docs/overview/features.md)，Agent 接入见 [docs/agent-integration.md](docs/agent-integration.md)。

## 技术栈

- 前端：Next.js、React、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query
- 后端：Go、Gin、GORM
- 本地 Agent 服务：TypeScript、Express、MCP SDK（`agent/` 目录）
- 存储：SQLite、本地 IndexedDB、S3 兼容对象存储、Cloudflare R2
- 部署：Docker

## 快速开始

```bash
git clone https://github.com/huahuazi/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
# 修改默认账号密码等信息
docker compose up -d --build
```

本地非 Docker 开发运行：

```bash
cp .env.example .env
go run .

# 另开一个终端窗口
cd web
bun install
bun run dev
```

本地源码构建运行：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

运行后默认端口 3000，可访问 `http://localhost:3000`。

如需要拉取提示词，可前往 `http://localhost:3000/admin/prompts`。

## 连接本地 Agent（让 AI 助手帮你操作画布）

**这个功能是干嘛的**：让 Codex / Claude Code 这类终端 AI 助手能读取你的画布、添加节点、建立连线、触发图片视频生成。它通过一个跑在你本机的"中间人"小程序（`agent/` 目录，监听 `127.0.0.1:17371`）与浏览器里的画布传话。

**前提**：电脑已安装 Codex 或 Claude Code 命令行工具。没有的话跳过本节——网页内自带的"画布助手"已能完成对话、生图、插回画布的常用操作。

**第一次使用（装一次中间人）**：

```bash
cd agent
npm install
npm run build
npm link        # 之后可直接使用 infinite-canvas-agent 命令
```

**每次使用（四步）**：

1. 终端运行 `infinite-canvas-agent`，保持该终端不关闭（关闭即断线）
2. 从输出中复制 `Connect token`（`Local URL` 固定为 `http://127.0.0.1:17371`，不用记）
3. 浏览器打开画布链接并追加连接参数（把 `你的token` 换成上一步复制的内容）：
   ```
   http://localhost:3000/canvas?agentUrl=http://127.0.0.1:17371&agentToken=你的token
   ```
4. 画布右上角出现绿色"已连接本地 Agent"徽标即成功；对 AI 助手说"读一下当前画布"即可开始操作

**给 AI 助手装 MCP（一次性）**：

```bash
# Codex
codex mcp add infinite-canvas -- infinite-canvas-agent mcp
# Claude Code
claude mcp add infinite-canvas -- infinite-canvas-agent mcp
```

也可以直接使用仓库自带的插件包，见 [plugins/](plugins/)：Codex 安装 `plugins/codex-infinite-canvas/`，Claude Code 安装 `plugins/claude-infinite-canvas/`。

详细说明（含 Gemini CLI、Cursor 与插件安装方式）见 [docs/agent-integration.md](docs/agent-integration.md)。

## New API 自动配置

如果使用 New API，可在 `系统设置 -> 聊天方式 -> 添加聊天设置` 中填入：

```text
https://infinite-canvas-cpco.onrender.com?apiKey={key}&baseUrl={address}
```

跳转后会自动打开配置弹窗并填入 API Key 和 Base URL。
如果自己部署了，可以把 `https://infinite-canvas-cpco.onrender.com` 替换成你部署的地址。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/d/7/c/d7cecc7df20fcd935ce760757f8799cf4436c936.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/6/0/7/607af375f9182a86f31655b8326337a536f70e34.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/6/e/6/6e60f82eec3602151abccc60fc4b55d028ac8415.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/8/b/a/8bae005a727727c8d83e0e01b05fea90155e56a5.jpeg" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/e/b/e/ebe20a7cb4c4837495cdbd55b4327fa741ce2938.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/0/f/b/0fbe4f543ac554a7950cf011ceb4586d27e6d681.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/MxXZkWc7/1.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/5g46rH3L/2.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://cdn3.ldstatic.com/original/4X/8/6/7/867532c5c6dfff38cfa2b90ca0e0f76809b066d4.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/BHjjXcV4/6.png" alt="image" border="0"></td>
  </tr>
</table>

## 文档

- [功能介绍](docs/overview/features.md)
- [Agent 接入文档](docs/agent-integration.md)
- [部署说明](docs/overview/docker.md)
- [画布节点操作手册](docs/canvas/canvas-node-manual.md)
- [画布快捷键](docs/canvas/canvas-shortcuts.md)
- [后端数据库说明](docs/backend/backend-database.md)
- [系统配置数据结构](docs/backend/system-settings.md)
- [接口响应约定](docs/backend/api-response.md)

## 开源协议

本项目使用 MIT License，见 [LICENSE](LICENSE)。