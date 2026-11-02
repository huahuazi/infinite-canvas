# 深度视频接入（WaveSpeedAI / Hugging Face）

> 版本：v0.10.x 起支持
> 最后核对：2026-11-02（接口字段均按官方文档与线上实测）

## 1. 这个功能和原来的「深度视频」有什么不同

画布右键的「生成深度视频」原本走**火山视频编辑任务**（`omni_reference_task_type=edit`）：
让 Seedance 按提示词把画面「改写」成深度图的样子。本质是生成，不是测量，
遮挡关系、模糊边缘、运动过快的地方都会糊，而且受「必须 4~30 秒、必须 Seedance 2.x」的限制。

新增的两个渠道跑的是**真实的单目深度估计模型**（ByteDance / HKU 的 Video Depth Anything），
逐帧估计每个像素到相机的相对距离，时间上做了跨帧归一化，不会闪烁。

| | 原方案（Ark edit） | 新方案（WaveSpeed / HF） |
|---|---|---|
| 原理 | 提示词让生成模型「画」深度图 | 真实深度估计模型逐帧推理 |
| 输入时长 | 4~30 秒 | WaveSpeed 600 秒 / HF 受 240 秒 GPU 限制 |
| 输出 | 带伪深度感的视频 | 真实相对深度视频（近白远黑） |
| 模型要求 | 必须 Seedance 2.5 / 2.0 | 任意（用深度专用模型） |
| 单价 | 走 Seedance 视频编辑计费 | ¥0.036/秒（WaveSpeed）或免费额度（HF） |

**原来的 Ark 路径完整保留**：渠道还是火山方舟时，右键菜单行为不变。

## 2. 两个渠道的官方接口

### 2.1 WaveSpeedAI（标准 REST）

| 步骤 | 请求 |
|---|---|
| 提交 | `POST https://api.wavespeed.ai/api/v3/{model}` |
| 查询 | `GET https://api.wavespeed.ai/api/v3/predictions/{id}/result` |
| 鉴权 | `Authorization: Bearer {WAVESPEED_API_KEY}` |
| 请求体 | `{"video": "https://公网可访问/video.mp4"}` |
| 响应 | `{"code":200,"data":{"id":"...","status":"completed","outputs":["https://..."]}}` |

模型 ID 直接就是路径主体，默认 `wavespeed-ai/depth-anything/video`；
需要可选配色（grayscale / inferno / turbo）时用 `wavespeed-ai/depth-anything-v3/video`。

状态值：`completed` 成功，`failed` / `cancelled` / `timeout` / `deleted` 失败终态，其余按处理中。
计费 $0.005/秒（最低 3 秒，最长 600 秒），产物保留输入分辨率、帧率上限 30fps、保留音轨。

> 官方文档明确：**提交请求不要自动重试**，一次不确定的失败可能产生第二个计费任务。

### 2.2 Hugging Face Gradio Space

官方 Space：`depth-anything/Video-Depth-Anything` → 直连域名 `depth-anything-video-depth-anything.hf.space`

Gradio 不是标准 REST，必须三步走：

| 步骤 | 请求 |
|---|---|
| ① 上传 | `POST {space}/gradio_api/upload`（multipart，字段名 `files`）→ `["/tmp/gradio/xxx/a.mp4"]` |
| ② 调用 | `POST {space}/gradio_api/call/infer_video_depth`，body `{"data":[...]}` → `{"event_id":"..."}` |
| ③ 监听 | `GET {space}/gradio_api/call/infer_video_depth/{event_id}`（SSE，读 `event: complete`） |
| 取片 | `{space}/gradio_api/file={path}`（注意是 `file=` 等号，不是 `file/`） |

`data` 数组的顺序必须与 Space 的端点签名完全一致，错一位上游直接抛异常且不带错误详情：

```
[0] input_video   {"path":"/tmp/gradio/xxx/a.mp4","meta":{"_type":"gradio.FileData"}}
[1] max_len       -1 = 全部帧
[2] target_fps    -1 = 保持原帧率
[3] max_res       480~1920，默认取 518（与模型内部 input_size 一致，最快最稳）
[4] grayscale     true = 单通道灰度；false = 伪彩
```

输出两路视频：`[0]` 是预处理后的原片，`[1]` 才是深度视频，**必须取第二个**。

> **ZeroGPU 强制要求登录**：未登录访客匿名调用会直接返回 `event: error`（实测）。
> 所以这个渠道的「API Key」填的是 Hugging Face Access Token（`hf_` 开头，Read 权限够用）。
> 免费账号每天 5 分钟 GPU，单次调用上限 240 秒（Space 源码 `@spaces.GPU(duration=240)`）。

## 3. 后台怎么配

进入「后台 → 系统设置 → 模型渠道 → 新建渠道」。

### WaveSpeed

| 字段 | 值 |
|---|---|
| 渠道名称 | WaveSpeed 深度视频 |
| 协议 | **WaveSpeedAI（深度视频）** |
| 接口地址 | `https://api.wavespeed.ai`（后端会自动补 `/api/v3`） |
| API Key | WaveSpeed 后台的 access key |
| 渠道可用模型 | `wavespeed-ai/depth-anything/video` |
| 模型类型 | 不用选（名字含 video，自动识别为视频） |

### Hugging Face

| 字段 | 值 |
|---|---|
| 渠道名称 | HF 深度视频 |
| 协议 | **HuggingFace（深度视频）** |
| 接口地址 | `https://depth-anything-video-depth-anything.hf.space` |
| API Key | Hugging Face Access Token（`hf_...`） |
| 渠道可用模型 | `video-depth-anything` |
| 模型类型 | 不用选 |

> 直接粘 `https://huggingface.co/spaces/depth-anything/Video-Depth-Anything` 也可以，
> 后端会自动换算成 `hf.space` 直连域名。

配完记得去「系统可用模型」把这几个模型勾进白名单，否则画布选择器里看不到。

## 4. 画布上怎么用

1. 模型选择器里切到深度模型（`wavespeed-ai/depth-anything/video` 或 `video-depth-anything`）
2. 选中一个视频节点 → 右键 → **生成深度视频**
3. 新的深度视频节点会挂在右侧，自动轮询直到完成

深度渠道下不会套用火山的 `ratio=adaptive` / `duration=-1`，也不再要求 4~30 秒。

## 5. 参数与限制

| 项 | WaveSpeed | Hugging Face |
|---|---|---|
| 源视频 | 必须公网 URL | 必须公网 URL（后端下载后 multipart 上传） |
| 输出分辨率 | 跟随输入 | 画布清晰度选项映射：480/720/1080，默认 518 |
| 最长输入 | 600 秒 | 受 240 秒 GPU 限制，实际约 10~20 秒素材 |
| 费用 | $0.005/秒 | 免费账号 5 分钟 GPU/天 |
| 产物 | CDN 链接，长期有效 | 后端自动转存到 `/api/media/references/`，Space 重启不丢 |

输出统一是灰度视频（近白远黑）。要做精确几何重建需要 16-bit 深度图序列，
两个渠道给的都是可视化视频，`fal.ai` 的 `.npz` 导出是唯一能拿到原始深度数据的路径。

## 6. 改动落点

### 后端（Go）

| 文件 | 改动 |
|---|---|
| `service/settings.go` | 新增 `IsWaveSpeedProtocol/BaseURL/Channel`、`IsHuggingFaceProtocol/BaseURL/Channel`、`IsDepthVideoModelName`、`IsDepthVideoChannel`；`BuildModelChannelURL` 为两家加专属拼接（WaveSpeed 补 `/api/v3`，HF 不补 `/v1`）；`isArkOpenAPIChannel` 排除两家；`AdminTestChannelModel` 加异步提示 |
| `handler/depth_video.go` | **新增**。WaveSpeed 请求体归一化 + 响应摊平；HF 的 upload/call/SSE 全流程、结果解析、产物转存 |
| `handler/video_task.go` | 创建流程前置分流 HF；`normalizeVideoCreateBody`/`transformVideoCreatePayload`/`transformVideoStatusPayload` 加 WaveSpeed；`pollVideoTaskFromUpstream` 加 HF 分支 |
| `handler/ai.go` | `resolveAIProxyPath` 加 WaveSpeed 路径映射；`isArkSeedanceVideo` 排除两家 |
| `service/video_task.go` | `NormalizeVideoTaskStatus` 把 `created` 归到排队中 |
| `handler/depth_video_test.go` | **新增**。覆盖协议判定、URL 拼接、请求体归一化、响应解析、SSE 解析、参数顺序 |

### 前端（TS）

| 文件 | 改动 |
|---|---|
| `lib/model-channel.ts` | 协议类型 + 默认地址 + Key 链接 + `wavespeedChannelTips`/`huggingfaceChannelTips` + 三个判定函数 |
| `stores/use-config-store.ts`、`services/api/admin.ts` | 协议联合类型加两个值 |
| `app/(admin)/admin/settings/page.tsx` | 协议下拉 + 列表 Tag + 四处提示 |
| `components/layout/app-config-modal.tsx` | 本地渠道协议下拉 |
| `services/api/video.ts` | `isDepthVideoRequest`、`createDepthVideoRequestBody`、`depthVideoMaxRes`；`createUrl`/`aiVideoPollUrl`/`createVideoRequestBody`/`isArkSeedanceVideoRequest` 加分支 |
| `lib/video-derive.ts` | `isRealDepthVideoConfig`；`applyVideoDeriveConfig` 与 `videoDeriveSupportIssue` 对真实深度渠道放行 |
| `app/(user)/canvas/[id]/canvas-client-page.tsx` | 派生节点时按渠道决定是否套用 Ark 参数 |

## 7. 已知限制

1. **本地直连模式下不能用**：两个渠道都强制走服务端代理。理由是**密钥不能落浏览器**
   （local 模式下 key 明文存 localStorage，一次 XSS 就漏），外加 Hugging Face 需要
   上传文件 + 监听 SSE、产物还得后端转存。
   > 注意：这不是跨域问题。实测 WaveSpeed 返回 `access-control-allow-origin: *`、
   > HF Space 会回显 Origin，浏览器直连在技术上可行，我们主动选择了不走。
2. **Hugging Face 没有可选的模型尺寸**：Space 写死 ViT-L。
3. **HF 的 SSE 重放依赖 Gradio 的内存缓存**：Space 重启后 event_id 失效，
   轮询会返回「event 已过期，请重新提交」。
4. **后台「测试渠道」对这两家只给提示不真跑**：它们的接口不是 OpenAI 形态，
   用 `/chat/completions` 探活必然失败。真实验证请在画布上跑一条。
5. **WaveSpeed 的提交请求不能自动重试**：官方明确警告重试可能产生第二个计费任务。
