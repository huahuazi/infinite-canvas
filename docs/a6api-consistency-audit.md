# A6API 协议接入 —— 全链路一致性审计

> 审计范围：文本 / 图片 / 视频三大能力在协议接入后的数据流、展示一致性与冲突点
> 结论：**发现 6 处真实问题（3 处 P0），已全部修复**；另有 6 处已知限制记录在案
> 验证：`go build` / `go test` / `tsc` / `next build` 全通过

---

## 一、这层协议是怎么接进来的

画布系统的渠道模型是「协议 + Base URL + 模型列表」三元组，协议决定**请求体长什么样、路径要不要改写、响应怎么解析**。A6API 插在第 5 层：

```
模型选择器（能力过滤）
   ↓
AiConfig（model / channelId / size / videoSeconds…）
   ↓
channelProtocolForConfig()  ← 决定走哪条协议分支
   ↓
请求构造（createVideoRequestBody / applyImageGenerationParams / chat body）
   ↓
aiApiUrl() → buildApiUrl()  ← 只负责拼 baseUrl + /v1 + path
   ↓
云端代理 /api/v1/*  →  后端 proxyAIRequest / proxyAIVideoTaskRequest
   ↓
resolveAIProxyPath()  ← 决定上游路径
   ↓
BuildModelChannelURL() → 上游
   ↓
响应归一化（normalize*）→ 画布节点 / 工作台
```

A6API 的特殊之处：**它在第 2 层（路径）和第 4 层（拼 URL）完全复用现有逻辑**，只在第 1 层（协议判定）和第 3 层（请求体）、第 5 层（响应解析）需要介入。

| 层 | A6API 的处理 | 是否改动 |
|---|---|---|
| 协议判定 | `IsA6APIChannel()`：显式 protocol 优先，`*.a6api.vip` 域名兜底 | 新增 |
| 路径改写 | `resolveAIProxyPath()` 返回原路径（标准 OpenAI） | 不改 |
| URL 拼装 | `buildApiUrl()` 裸域名补 `/v1` | 不改 |
| 鉴权 | `aiHeaders()` / `SetModelChannelAuthHeader()` → Bearer | 不改 |
| 文本请求 | 标准 `/chat/completions` | 不改 |
| 图片请求 | 标准 `/images/generations`、`/images/edits` | 不改 |
| 视频请求 | **必须 JSON**，不能走默认 FormData 分支 | 新增 |
| 视频解析 | **completed 可能无 url**，需 `/content` 转存 | 新增 |
| 错误处理 | `readUpstreamAIErrorMessage()` 读 `error.message` | 不改 |

---

## 二、三类能力的数据流

### 2.1 文本

```
用户输入 → canvas-agent / 对话组件
  → aiApiUrl(config, "/chat/completions")
  → 云端：/api/v1/chat/completions → proxyAIRequest
  → resolveAIProxyPath 原样 → BuildModelChannelURL 拼 /v1
  → https://api.a6api.vip/v1/chat/completions
  → SSE 或 JSON 原样回传
```

**无额外分支**，与默认 `openai` 协议完全同构。唯一差异是 `isArkSeedanceVideo` 的排除——文本路径本来就不经过它。

### 2.2 图片

```
用户点生成 → requestImageGeneration
  → createImageRequestParams（quality/size/n）
  → applyImageGenerationParams（标准 size/quality）
  → aiApiUrl(config, "/images/generations")
  → 同步返回 data[].url / b64_json
  → parseImagePayload → 画布节点
```

编辑走 `/images/edits`，multipart 字段 `image` / `mask` / `model` / `prompt`，与 A6API 文档一致。

### 2.3 视频（最复杂，也是问题集中区）

```
① 页面层 buildVideoConfig
     ├─ 归一化 size（像素 vs 比例）   ← 问题 #1 就出在这里
     └─ 归一化 videoSeconds
② createVideoRequestBody
     └─ isA6APIVideoRequest() → createA6APIVideoRequestBody（JSON）
③ aiApiUrl("/videos") → /api/v1/videos
④ 后端 proxyAIVideoTaskRequest
     ├─ rewriteModelChannelRequestBody（model alias）
     ├─ 不改路径
     └─ 任务入库 video_tasks（upstream_task_id / status）
⑤ 前端轮询 aiVideoPollUrl("/videos/{id}")
     └─ 后端 serveAIVideoTask → parseVideoTaskPayload（通用解析）
⑥ 状态 completed
     └─ cacheA6APIVideo → GET /v1/videos/{id}/content
        → uploadMediaFile → 项目存储 → 画布节点
```

**第 ⑥ 步是 A6API 与火山最大的差异**：火山的 `content.video_url` 直接可用，A6API 的 `completed` 可能只给状态不给地址。不做这一步，画布节点会永远停在「正在创作」或裂图。

---

## 三、发现的问题与修复

### P0-1 ｜ a6api 的 seedance 模型被套用火山语义，清晰度被静默丢弃

| 项 | 内容 |
|---|---|
| 位置 | `lib/seedance-video.ts` → `isSeedanceVideoConfig()` |
| 波及 | `app/(user)/video/page.tsx:2796` `buildVideoConfig`、`components/video-settings-panel.tsx:83`、`services/api/video.ts:454` |
| 影响页面 | 视频创作台、画布视频节点、画布视频设置弹层 |
| 现象 | UI 渲染成 Seedance 专属面板；`buildVideoConfig` 把 `size` 归一化成 `"16:9"`，请求体再转回 `1280x720` → **用户选 1080p，实际发 720p** |

**原因**：`isSeedanceVideoConfig` 只按模型名判断，`doubao-seedance-2.5` 命中后整套火山语义（ratio / resolution）被强行套到 A6API 上。

**修复**：给函数加 `protocol` 参数，`a6api` 直接返回 `false`；4 个调用点同步传 `channelProtocolForConfig(config)`。

**验证**：tsc 通过；逻辑上 `buildVideoConfig` 走 `normalizeVideoSize` 分支，`size` 保持像素。

---

### P0-2 ｜ 多张参考图只发了第一张

| 项 | 内容 |
|---|---|
| 位置 | `services/api/video.ts` → `createA6APIVideoRequestBody()` |
| 影响场景 | 多参考图生视频（画布挂 3~9 张素材） |
| 现象 | UI 允许挂 30 张，请求体只带 `image`（第一张），用户以为全用上了 |

**修复**：1 张走 `image`，多张走 `images` 数组（文档明确支持复数形式），上限沿用现有 9 张。

---

### P0-3 ｜ `body.audio` 误传音频 URL，字段语义错误

| 项 | 内容 |
|---|---|
| 位置 | 同上 |
| 影响场景 | 带参考音频提交视频 |
| 现象 | 文档里 `audio / sound / with_audio` 是**是否生成音频的布尔开关**，不是音频输入。传 URL 会被上游当布尔解析 → `video_spec_unrecognized` |

**修复**：删除该字段，注释说明参考音频当前不发送（A6API 文档未提供音频输入字段）。

---

### P1-4 ｜ 首帧上传口对 veo / kling 不显示

| 项 | 内容 |
|---|---|
| 位置 | `lib/video-model-capabilities.ts` → `supportsVideoFrameReferences()` |
| 波及 | 视频台、画布视频弹层、画布客户端（5 个调用点） |
| 现象 | 该函数按模型名硬编码，`veo-3.1` 只有 `protocol === "gemini"` 才放行，`kling-3.0` 不在名单 → **图生视频的上传口直接不渲染** |

**修复**：`protocol === "a6api"` 直接返回 `true`。A6API 把 `first_frame_image` / `last_frame_image` 做成通用可选字段，尾帧是否接受交给上游校验。

---

### P1-5 ｜ 时长上限没体现在 UI，选了 30 秒实际发 10 秒

| 项 | 内容 |
|---|---|
| 位置 | `components/video-settings-panel.tsx`（通用面板）、`services/api/video.ts` |
| 现象 | 输入框固定 `max=30`，而 `kling-2.6` 上限 10 秒、`veo-3.1` 固定 8 秒。请求体静默 clamp，UI 仍显示 30 |

**修复**：把时长规则抽到 `lib/a6api-video.ts`，请求体与面板共用同一张表：
- 面板按模型过滤秒数预设（veo-3.1 只显示 8 秒）
- `NumberInput` 的 max 跟随模型上限
- 面板下方给出「当前模型最长 N 秒 / 固定 N 秒」提示

---

### P1-6 ｜ `ideogram-4` 被归到「文本」

| 项 | 内容 |
|---|---|
| 位置 | `service/settings.go` → `isImageModelName()`；`stores/use-config-store.ts` → `isImageModelName()` |
| 现象 | 模型名既不含 `image` 也不含 `imagen`，前后端都猜成文本 → 图片选择器里看不到 |

**修复**：前后端关键词表都补 `ideogram`。后端补了 `TestA6APIModelCapabilityGuess` 覆盖 11 个模型。

---

## 四、已知限制（4 项未改 + 2 项已对齐）

> 参考视频与参考图的「UI 上限 vs 实际发送量」已在 v0.10.12 对齐，见下表 ✅ 两行。

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| 1 | 图片「流式出图」的 `partial_images` 仅文档标注「DTO 可接收」 | 开启流式出图可能失败 | 未改。默认关闭，属用户主动配置 |
| 2 | ✅ 参考视频 UI 允许 3/10 个，请求体只发第 1 个 | 第 2 个起被静默丢弃 | **已修**：a6api 渠道下 UI 上限设为 1，空态提示同步改成 1 |
| 3 | ✅ 参考图 UI 允许 9/30 张，请求体只发前 9 张 | 超出部分静默丢弃 | **已修**：a6api 渠道下 UI 上限设为 9，与 `images` 数组发送量一致 |
| 3b | ✅ 参考音频 UI 允许 3/10 个，请求体完全不发 | 用户挂了音频等于没挂 | **已修**：a6api 渠道下上限设为 0，选文件/读剪贴板时明确提示「当前渠道不支持参考音频」 |
| 4 | `text-embedding-*`、`gemini-embedding-*` 会被归到文本选择器 | 用户误选后调用失败 | 未改。平台把它们标成 `openai` 端点，系统没有 embedding 能力类型 |
| 5 | A6API 专属错误码无中文映射 | 提示不够精准 | 未改。`video_duration_invalid` 会被现有 `duration` 正则命中，其余显示上游中文 message |
| 6 | 表外模型（`gemini-omni-1.1-flash`）规格未知 | 尺寸/时长可能被拒 | 未改。文档未给规格表，只能按默认 60 秒保护 |

### 对齐 2 / 3 时的附带修复

`slice(0, audioReferenceLimit - audioReferences.length)` 在上限为 0、已有素材时会得到**负数**，
`Array.prototype.slice` 对负数是从尾部倒数，结果反而保留了元素。
两处（文件选择、剪贴板读取）都补了 `Math.max(0, …)`。

---

## 五、调用关系总结

| 关注点 | 结论 |
|---|---|
| 路径改写 | **无冲突**。A6API 走标准 OpenAI 路径，`resolveAIProxyPath` 原样返回 |
| URL 拼装 | **无冲突**。`buildApiUrl` / `BuildModelChannelURL` 对裸域名补 `/v1`，已带则不重复 |
| 鉴权 | **无冲突**。三协议统一 Bearer，A6API 不需要 key 前缀 |
| 渠道判定 | **有冲突，已修**。`isSeedanceVideoConfig` 抢走了 a6api 的 seedance 模型 |
| 请求体 | **有冲突，已修**。默认 FormData 分支不适用于 A6API；参考图/音频字段语义错 |
| 响应解析 | **设计已覆盖**。通用 `parseVideoTaskPayload` 能读 `status` / `error.message`，`video_url` 缺失由 `cacheA6APIVideo` 兜底 |
| 模型能力 | **有冲突，已修**。`kling` / `veo` / `viduq3` / `sora` / `ideogram` 前后端关键词表均补齐 |
| 白名单 | **无冲突**。后台保存渠道时 `mergeModels` 自动并入新模型，`filterEnabledModels` 只清失效项 |
| 默认模型 | **无冲突**。`repairDefaultModel` 按显式类型校验，不会把视频模型塞进 `defaultTextModel` |
| 云端/本地渠道 | **无冲突**。`activeChannelForConfig` 按 `channelMode` 分流，A6API 走同一套解析 |

---

## 六、验证记录

| 项目 | 结果 |
|---|---|
| `go build ./...` | 通过 |
| `go vet ./handler/ ./service/` | 通过 |
| `go test ./...` | 全绿（新增 `TestA6APIModelCapabilityGuess` 覆盖 11 个模型） |
| `npx tsc --noEmit` | 11 个错误，全部为历史遗留；**本次改动文件 0 错误** |
| `npm run build` | 通过，18 条路由正常 |

**未验证**：真实上游调用（需令牌、会产生费用）。浏览器端到端按约定由你自测，重点看三处：
1. 视频台切到 a6api 的 `doubao-seedance-2.5`，确认面板不再是 Seedance 专属样式，清晰度选项与实际发送一致
2. 挂 3 张参考图提交，确认请求体带的是 `images` 数组而不是单张
3. 视频完成后确认画布节点能播放（验证 `/content` 转存链路）
