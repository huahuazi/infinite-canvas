# A6API 接入说明（文本 / 图片 / 视频）

> 接入对象：`https://api.a6api.vip`（A6API 聚合网关，New API 定制分支）
> 代码位置：`infinite-canvas/`，新增协议标识 `a6api`
> 状态：已实现，`go build` / `go test` / `tsc` / `next build` 全部通过

---

## 1. 为什么需要单独一个协议

A6API 的接口形态就是标准 OpenAI 兼容，路径和默认的 `openai` 协议**一模一样**：

| 能力 | 路径 |
|---|---|
| 文本 | `POST /v1/chat/completions`、`POST /v1/responses` |
| 图片 | `POST /v1/images/generations`、`POST /v1/images/edits` |
| 视频 | `POST /v1/videos`、`GET /v1/videos/{id}`、`GET /v1/videos/{id}/content` |

那为什么不能直接用 `openai` 协议？因为画布里有两处**按模型名兜底**的判断：

1. `isArkSeedanceVideo()` / `isArkSeedanceVideoRequest()`：模型名只要含 `seedance`，就会被改写成火山的 `/contents/generations/tasks`。A6API 上挂着 `doubao-seedance-2.0/2.5`，直接选 `openai` 会 404。
2. `isVideoModelName()`：`kling-3.0`、`veo-3.1`、`viduq3`、`sora-2` 这些名字不带 `video`，会被猜成"文本"，在视频选择器里根本出不来。

所以新增 `a6api` 协议的核心作用是**声明"这是标准 OpenAI 视频协议，别按火山那套改写"**，同时让能力猜测认识这批新模型名。

---

## 2. 配置项

### 2.1 后台渠道（推荐）

控制台 → 后台 → 系统设置 → 模型渠道 → 新增：

| 字段 | 填什么 |
|---|---|
| 协议 | **A6API** |
| 接口地址 | `https://api.a6api.vip`（不要带 `/v1/xxx` 完整路径） |
| API Key | 控制台「令牌管理」里复制的完整令牌 |
| 渠道可用模型 | 从模型市场复制，或点「选择模型」拉 `/v1/models` |
| 模型类型 | **手动指定**，见 2.3 |
| 模型名映射 | 一般留空（A6API 对外模型 id 就是上游真名） |
| 权重 / 超时 | 超时建议 ≥ 600 秒（视频是异步的，但提交本身可能慢） |

### 2.2 本地渠道

画布 → 设置 → 模型渠道 → 新增，协议同样选 **A6API**，Base URL 与 Key 同上。

### 2.3 模型类型必须手动指定（重要）

`kling-3.0`、`veo-3.1`、`viduq3-pro`、`sora-2`、`happyhorse-1.1`、`gemini-omni-1.1-flash` 这些名字，
前后端的自动猜测都认不出来，会被归到"文本"。请在这两个地方把它们选成**视频**：

- 后台渠道抽屉 →「模型类型」逐条选择并保存（写进 `modelCapabilities`）
- 本地渠道 → 选择模型后同样可指定

不指定的后果不是报错，而是**视频模型在视频选择器里看不见**——这类"静默不出现"最难排查。

---

## 3. 三类能力接入

### 3.1 文本

- 走 `POST /v1/chat/completions`（也支持 `/v1/responses`、`/v1/messages`、`/v1beta/models/{m}:generateContent`）
- 鉴权：`Authorization: Bearer <KEY>`
- 请求/响应结构完全标准 OpenAI，`choices[].message.content`
- **代码改动：无。** `image.ts` 的 `aiApiUrl(config, "/chat/completions")` 会拼成 `https://api.a6api.vip/v1/chat/completions`，天然可用

需要注意的上游行为：

- 该平台部分是"号池"货源，`temperature`、`top_p`、`max_tokens`、`seed`、`logprobs` 可能被**静默忽略**，不报错但也不生效
- 流式可用，但平台文档没写 SSE 事件格式（属于文档缺口，不影响调用）

### 3.2 图片

- 走 `POST /v1/images/generations`（文生图）与 `POST /v1/images/edits`（编辑，支持 multipart）
- 同步返回，读 `data[].url` 或 `data[].b64_json`
- `size` 必须用**半角 x**（`1024x1024`），全角 `×` 会被网关直接拒
- **代码改动：无。** 现有 `requestImageGeneration` / `requestImageEdit` 已经是标准 OpenAI 形态

实际挂牌的图片模型（13 个）：

```
gpt-image-1 / 1.5 / 2 / 2.5 / 2.5-flare / 2.5-sunburst
flux-3-image / flux-3-image-klein
grok-imagine-image / -2.0 / -edit / -lite / -pro
```

⚠️ 该平台**文档里举例的** `dall-e` 全系、`gpt-image-1-mini`、`imagen-*`、`google-imagen-*`、`nano-banana*` 当前并不在 `image-generation` 挂牌清单内，照抄文档示例会失败。

### 3.3 视频

这是改动最多的部分。

**请求构造**（新增 `createA6APIVideoRequestBody`）：

```json
{
  "model": "kling-3.0",
  "prompt": "...",
  "seconds": 10,
  "size": "1280x720",
  "first_frame_image": "https://... | data:image/png;base64,...",
  "last_frame_image": "...",
  "image": "...",
  "generate_audio": true,
  "metadata": { "negative_prompt": "..." }
}
```

关键点：

1. **必须是 JSON，不能沿用默认分支的 FormData**
   默认分支会 append `resolution_name`、`preset`、`input_reference[]` 这些 A6API 不认识的字段，还会把 `model`/`prompt` 塞进 multipart。所以单独建了 JSON 分支。
2. **只发有值的字段**
   该平台对规格是强校验，给不支持音频的模型多塞一个 `generate_audio` 会直接回 `video_spec_unrecognized`。
3. **首尾帧与普通参考图分开**
   有首帧走 `first_frame_image`，否则拿参考图第一张走 `image`；尾帧走 `last_frame_image`。混着发会被判规格冲突。
4. **时长按模型收敛**（新增 `normalizeA6APIVideoSeconds`）

| 模型 | 收敛规则 |
|---|---|
| `veo-3.1` / `-fast` / `-lite` | 固定 8 秒 |
| `kling-2.6` | 最多 10 秒 |
| `kling-3.*` / `kling-4` | 最多 15 秒 |
| `viduq3-*` | 最多 16 秒 |
| `sora-2` / `-pro` | 最多 12 秒 |
| `grok-imagine-video-1.5` | 最多 15 秒 |
| `minimax-h3` / `happyhorse-1.1` | 最多 15 秒 |
| `doubao-seedance-2.5` / `wan3.*` | 最多 30 秒，支持 `-1` |
| `doubao-seedance-2.0*` | 最多 15 秒，支持 `-1` |
| 表外模型 | 最多 60 秒 |

**响应解析**（新增 `normalizeA6APIVideoResponse`）：

- 任务对象是 `{ id | task_id, status: queued | in_progress | completed | failed }`
- 与 Ark 最大的差异：**`completed` 时可能只给状态、不给 `video_url`**
- 因此新增 `cacheA6APIVideo`：完成后统一走 `GET /v1/videos/{id}/content` 拉二进制，直接进项目存储；下载失败才退回响应里的外链做镜像

这一步不能省。该平台明确说明"结果 URL 生命周期不能假定"，把上游地址直接写进 `project_data`，过一阵子画布里就是一片裂图。

---

## 4. 代码改动清单

### 后端（Go）

| 文件 | 改动 |
|---|---|
| `service/settings.go` | 新增 `IsA6APIProtocol` / `IsA6APIBaseURL` / `IsA6APIChannel`；`AdminTestChannelModel` 排除 A6API，避免测 seedance 时打 Ark 接口；`isVideoModelName` 补 `kling` / `veo-` / `vidu` / `sora` / `happyhorse` / `gemini-omni` |
| `handler/ai.go` | `isArkSeedanceVideo` 新增 A6API 排除（否则 seedance 被改写成 `/contents/generations/tasks`） |
| `handler/a6api_protocol_test.go` | 新增 4 组回归测试 |

### 前端（TS）

| 文件 | 改动 |
|---|---|
| `lib/model-channel.ts` | 协议类型加 `a6api`、默认地址 `https://api.a6api.vip`、`a6apiChannelTips`、`isA6APIBaseUrl()` |
| `stores/use-config-store.ts` | `LocalModelChannel.protocol` 联合类型加 `a6api`；视频关键词补 `gemini-omni` |
| `services/api/admin.ts` | `AdminModelChannel.protocol` 联合类型加 `a6api` |
| `app/(admin)/admin/settings/page.tsx` | 协议下拉 + 列表 Tag + 三处配置提示 |
| `components/layout/app-config-modal.tsx` | 本地渠道协议下拉 |
| `services/api/video.ts` | `isA6APIVideoRequest`、`createA6APIVideoRequestBody`、`normalizeA6APIVideoSeconds`、`normalizeA6APIVideoResponse`、`cacheA6APIVideo`；`isArkSeedanceVideoRequest` 排除 a6api；两处转存调用链接入 |
| `lib/video-derive.ts` | A6API 加入"不支持火山视频编辑任务"的协议列表 |

**没有改动** `lib/seedance-video.ts`：A6API 用标准路径，不需要 Ark/Flatkey 那套 Base URL 归一化。

---

## 5. 统一封装与错误处理

三类能力共用同一套入口，没有为 A6API 另开一条链路：

- **URL 拼装**：`buildApiUrl()`（前端）/ `BuildModelChannelURL()`（后端）。裸域名自动补 `/v1`，已带 `/v1` 不重复补——已有单测覆盖 4 种写法
- **鉴权**：`aiHeaders()`（前端）/ `SetModelChannelAuthHeader()`（后端），A6API 走 `Authorization: Bearer`
- **错误读取**：`readAxiosError()`（前端）/ `readUpstreamAIErrorMessage()`（后端）。A6API 的错误体是 `{"error":{"code","message","reason","solution","request_id"}}`，现有逻辑读 `error.message` 即可，`message` 里已包含原因与 request_id
- **请求日志**：复用 `writeVideoAICallLog()` / `saveAIProxyLog()`，渠道名与端点都会记进调用日志

错误码与处理建议：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `invalid_api_key` | 令牌无效 | 核对完整令牌与 Bearer 格式 |
| `insufficient_user_quota` | 余额不足 | 充值 |
| `token_quota_exhausted` | 令牌硬额度用完 | 换令牌或提额度，**充值不解决** |
| `model_not_allowed` | 令牌没这个模型权限 | 换 `/v1/models` 里可见的模型 |
| `marketplace_price_guard_triggered` (402) | 价格保护 | 换路由/商家，**不是余额问题** |
| `video_duration_invalid` | 时长非法 | 已在本地按模型表收敛，仍报错说明模型名不在表内 |
| `video_spec_no_supplier` | 规格无人承接 | 换规格或换模型，本次不创建任务 |
| `video_submit_upstream_acceptance_unknown` | 商家可能已接单但网关不确定 | **不要重复提交**，等状态或联系客服 |

---

## 6. 已知限制

| 限制 | 影响 | 规避 |
|---|---|---|
| 视频任务不能取消、不能列表 | 提交错规格只能等它跑完 | 提交前用 3.3 的时长收敛兜住 |
| 没有 Webhook 回调 | 只能轮询 | 复用现有 `VIDEO_POLL_INTERVAL_MS = 5000` |
| 无幂等键 | 超时重试可能重复扣费 | 失败重试前先查任务状态 |
| 部分模型无 `video_url` | 必须走 `/content` | 已由 `cacheA6APIVideo` 处理 |
| 号池货源参数静默失效 | `temperature`/`max_tokens` 可能不生效 | 生产环境把关键参数写进 prompt 或换官方货源 |
| `gemini-omni-1.1-flash` 等表外模型 | 时长上限未知 | 按默认 60 秒保护，实际以报错为准 |

---

## 7. 验证记录

| 项目 | 结果 |
|---|---|
| `go build ./...` | 通过 |
| `go vet ./handler/ ./service/` | 通过 |
| `go test ./...` | 通过（config / handler / service 全绿） |
| 新增 4 组 a6api 协议测试 | 全部 PASS |
| `npx tsc --noEmit` | 11 个错误，**全部为历史遗留**，改动文件 0 错误 |
| `npm run build` | 通过，18 条路由正常产出 |

**未做的验证**：真实调用上游生成（需要有效令牌，且会产生费用）。按你的要求，浏览器端到端测试由你自己跑。

---

## 8. 上线前自查

1. 后台加渠道 → 协议选 A6API → 填 Base URL 与 Key
2. 点「拉取全部渠道」确认能读到模型列表
3. 给 `kling-3.0`、`veo-3.1`、`sora-2` 等手动指定「视频」类型
4. 保存后到画布的模型选择器确认三类模型都能出现
5. 文本：随便发一句，看是否正常返回
6. 图片：用 `gpt-image-2.5` 出一张 1024x1024
7. 视频：用 `kling-3.0` 出 5 秒，确认能轮询到 completed 且成品能播放（这一步会验证 `/content` 转存链路）
