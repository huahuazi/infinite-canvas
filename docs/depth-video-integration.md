# 深度视频接入（WaveSpeedAI）

> 版本：v0.11.x 起支持
> 最后核对：2026-11-02（接口字段均按官方文档与线上实测）

## 1. 这个功能和原来的「深度视频」有什么不同

画布右键的「生成深度视频」原本走**火山视频编辑任务**（`omni_reference_task_type=edit`）：
让 Seedance 按提示词把画面「改写」成深度图的样子。本质是生成，不是测量，
遮挡关系、模糊边缘、运动过快的地方都会糊，而且受「必须 4~30 秒、必须 Seedance 2.x」的限制。

新渠道跑的是**真实的单目深度估计模型**（ByteDance / HKU 的 Video Depth Anything），
逐帧估计每个像素到相机的相对距离，时间上做了跨帧归一化，不会闪烁。

| | 原方案（Ark edit） | 新方案（WaveSpeed） |
|---|---|---|
| 原理 | 提示词让生成模型「画」深度图 | 真实深度估计模型逐帧推理 |
| 输入时长 | 4~30 秒 | 最长 600 秒 |
| 输出 | 带伪深度感的视频 | 真实相对深度视频（近白远黑） |
| 模型要求 | 必须 Seedance 2.5 / 2.0 | 任意（用深度专用模型） |
| 单价 | 走 Seedance 视频编辑计费 | $0.005/秒 |

**原来的 Ark 路径完整保留**：渠道还是火山方舟时，右键菜单行为不变。

## 2. 官方接口

### 2.1 提交任务

```
POST https://api.wavespeed.ai/api/v3/{model}
Authorization: Bearer {WAVESPEED_ACCESS_KEY}
{"video": "<模型可访问的视频地址>"}
```

模型 ID 直接就是路径主体，默认 `wavespeed-ai/depth-anything/video`；
需要可选配色（grayscale / inferno / turbo）时用 `wavespeed-ai/depth-anything-v3/video`。

### 2.2 查询结果

```
GET https://api.wavespeed.ai/api/v3/predictions/{id}/result
```

响应：`{"code":200,"data":{"id":"...","status":"completed","outputs":["https://..."]}}`

状态值：`completed` 成功；`failed` / `cancelled` / `timeout` / `deleted` 是失败终态；其余按处理中。
计费 $0.005/秒（最低 3 秒，最长 600 秒），产物保留输入分辨率、帧率上限 30fps、保留音轨。

> 官方文档明确：**提交请求不要自动重试**，一次不确定的失败可能产生第二个计费任务。

### 2.3 素材直传（关键）

只把 URL 交给上游，WaveSpeed 会**自己去回源拉取**。如果它拉不到你的域名，
会报 `4006 Could not read the duration of the provided media`（官方对 4006 的定义
就是「媒体时长读不出来」），而不是明确说「拉不到」。

所以本项目一律走官方素材直传：

```
① POST /api/v3/media/uploads         取一次性票据
   {"filename":"a.mp4","size":12345,"content_type":"video/mp4"}
   → {"data":{"download_url":"https://...","upload":{"method":"PUT","url":"https://...","headers":{...}}}}

② PUT <票据里的 url>                 文件字节直传存储
   ⚠️ 绝对不能带 Authorization（官方明确禁止，票据本身就是凭证）

③ 用 data.download_url 提交任务
```

素材上限 200MiB、保留 7 天。这条路径完全不依赖对方能否访问我们的域名。

## 3. 后台怎么配

进入「后台 → 系统设置 → 私有配置 → 模型渠道 → 新增渠道」。

| 字段 | 值 |
|---|---|
| 渠道名称 | WaveSpeed 深度视频 |
| 协议 | **WaveSpeedAI（深度视频）** |
| 接口地址 | `https://api.wavespeed.ai`（后端自动补 `/api/v3`） |
| API Key | WaveSpeed 后台的 access key |
| 渠道可用模型 | `wavespeed-ai/depth-anything/video` |
| 模型类型 | 视频 |
| 请求超时 | 600 |
| 启用 | 打开 |

> 「拉取模型列表」对 WaveSpeed 永远失败——它没有 OpenAI 风格的 `/models` 接口，手输模型名即可。

配完去「公开配置 → 系统可用模型」把模型勾进白名单，否则画布选择器里看不到。

## 4. 画布上怎么用

1. 模型选择器里切到 `wavespeed-ai/depth-anything/video`
2. 选中一个视频节点 → 右键 → **生成深度视频**
3. 新的深度视频节点会挂在右侧，自动轮询直到完成

深度渠道下不会套用火山的 `ratio=adaptive` / `duration=-1`，也不再要求 4~30 秒。

## 5. 常见报错

| 报错 | 含义 | 处理 |
|---|---|---|
| `4006 Could not read the duration` | 上游回源拉不到视频（旧实现） | 已改直传，不再出现 |
| `401 Invalid API key` | key 不对 | 检查 access key |
| `上传素材到 WaveSpeed 失败：HTTP 4xx` | 直传被拒 | 看配额或文件是否超 200MiB |
| `当前渠道是深度视频渠道，请先把视频模型切换为深度模型` | 模型没切 | 切模型 |

## 6. 改动落点

### 后端（Go）

| 文件 | 改动 |
|---|---|
| `service/settings.go` | `IsWaveSpeedProtocol/BaseURL/Channel`、`IsDepthVideoModelName`、`IsDepthVideoChannel`；`BuildModelChannelURL` 补 `/api/v3`；`isArkOpenAPIChannel` 排除；`AdminTestChannelModel` 加异步提示 |
| `handler/depth_video.go` | 源视频读取（自家出口走磁盘短路）、素材直传、任务提交与响应摊平 |
| `handler/video_task.go` | 创建流程前置分流；轮询响应转换 |
| `handler/ai.go` | `resolveAIProxyPath` 路径映射；`isArkSeedanceVideo` 排除 |
| `service/video_task.go` | `created` 归到排队中 |
| `handler/depth_video_test.go` 等 | 协议判定、URL 拼接、请求体归一化、响应解析、直传票据、本地短路 |

### 前端（TS）

| 文件 | 改动 |
|---|---|
| `lib/model-channel.ts` | 协议类型 + 默认地址 + Key 链接 + `wavespeedChannelTips` + 判定函数 |
| `stores/use-config-store.ts`、`services/api/admin.ts` | 协议联合类型 |
| `app/(admin)/admin/settings/page.tsx` | 协议下拉 + 列表 Tag + 提示 |
| `components/layout/app-config-modal.tsx` | 本地渠道协议下拉 |
| `services/api/video.ts` | `isDepthVideoRequest`、`createDepthVideoRequestBody`、创建/轮询 URL 分支 |
| `lib/video-derive.ts` | `isRealDepthVideoConfig` 放行深度渠道 |
| `app/(user)/canvas/[id]/canvas-client-page.tsx` | 派生节点时按渠道决定是否套用 Ark 参数 |

## 7. 已知限制

1. **本地直连模式下不能用**：强制走服务端代理，理由是密钥不能落浏览器
   （local 模式下 key 明文存 localStorage）。注意这不是跨域问题。
2. **产物是 CDN 链接**，长期有效，不做本地转存。
3. **后台「测试渠道」只给提示不真跑**：其接口不是 OpenAI 形态。
4. **WaveSpeed 提交不能自动重试**：官方明确警告可能产生第二个计费任务。
5. **素材直传上限 200MiB**，超出会明确报错。

## 8. 已移除：Hugging Face 渠道

曾同时支持 Hugging Face 的官方 Space（`depth-anything/Video-Depth-Anything`），
走 Gradio 的 `upload → call → SSE` 协议。该 Space 自 2026-08 起报
`Zero GPU Worker Error`（讨论区两条报告均为 open，作者自 2025-03 未再更新），
网页手动运行与 API 调用都会得到 `event: error / data: null`，故按需求整体移除。
