# 灵智 AI（Anmiao 按秒通道）对接对照

> 对照对象：站内「全部复制」导出的《SD 2.5 满血版 按秒 · 接入文档》（灵智AI）+ <https://lingzhiai.lk666.ai/apidoc#model/seedance-2.5-guanfang-anmiao>
> 对照代码：`web/src/lib/seedance-video.ts`、`web/src/services/api/video.ts`、`handler/model_alias.go`、`handler/video_task.go`、`handler/ai.go`、`service/lingzhi.go`
> 核对时间：2026-10-25

---

## 一、结论速览

| 维度 | 结果 |
| --- | --- |
| 接口地址 | 对称（`/api/v3/anmiao/contents/generations/tasks`）；**文档站 `lk666.ai` 不是 API 域名**，误填会拿到 HTML 200 |
| 鉴权 | 对称（`Authorization: Bearer sk-xxx`；上游同时接受 `x-api-key`） |
| 请求字段 | 主打字段对称（`model` / `content[]` / `ratio` / `resolution` / `duration`）；`omni_reference_task_type` 属多余字段 |
| 数据类型 | 已修：`duration` 强制整数秒、缺失补默认值、越界收敛 |
| 枚举取值 | 已修：时长补齐 4~30 全整数；素材数量按型号放开；`last_frame` 补同传校验 |
| 必填项 | `model` / `content` / `duration` 必填，`resolution` 实际可选（缺省 720p），画布恒发不影响 |
| 响应结构 | 对称（`id`、`status`、`content.video_url`、`duration`、`usage.output_seconds`） |
| 错误码 | 上游 `{"error":{code,message,param,type}}`；已补 `InvalidParameter` / `BadRequest` 等中文指引 |
| 未对齐项 | 联网搜索（`tools`）、4K（2.0）、`callback_url` 未接入；失败任务自动退款未对齐（见第四节） |

---

## 二、灵智 Anmiao 通道对接基线（独立一套）

### 1. 地址与鉴权

| 项 | 值 |
| --- | --- |
| API 域名 | `https://api.lk888.ai` 或 `https://api.lingkeai.ai`（**不是** `lingzhiai.lk666.ai`，后者是文档站） |
| Base URL | `https://api.lk888.ai/api/v3/anmiao` |
| 创建任务 | `POST {BaseURL}/contents/generations/tasks` → `{"id":"99936297"}`（纯数字**字符串**） |
| 查询任务 | `GET {BaseURL}/contents/generations/tasks/{id}` |
| 鉴权 | `Authorization: Bearer sk-xxx`（`x-api-key` 亦可） |
| 回调 | 可选 `callback_url`，终态时 POST 与查询接口相同的 body；10s / 30s / 60s 重试共 4 次。画布用轮询，不传 |

### 2. 请求体（Ark 格式）

```json
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "提示词" },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "first_frame" },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "last_frame" },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "reference_image" },
    { "type": "video_url", "video_url": { "url": "https://..." }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "https://..." }, "role": "reference_audio" }
  ],
  "ratio": "adaptive",
  "resolution": "720p",
  "duration": 8
}
```

| 字段 | 类型 | 必填 | 取值 / 说明 | 画布现状 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | **火山真名** `doubao-seedance-2-5-260628`，不是平台 SKU | 靠渠道 `modelAliases` 改写；缺失时本地报错 |
| `content` | array | 是 | 素材 + 提示词，按 `role` 自动判定模式 | 对称 |
| `content[].type` | enum | 是 | `text` / `image_url` / `video_url` / `audio_url` | 对称 |
| `content[].role` | enum | 否 | `first_frame` / `last_frame` / `reference_image` / `reference_video` / `reference_audio`；首帧不填 role 也视为首帧 | 显式带 role |
| `ratio` | enum | 否 | `adaptive`（缺省）/ `16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `21:9`；**2.5 首帧任务仅 adaptive** | 2.5 首尾帧已强制 `adaptive` |
| `resolution` | enum | 否 | `480p` / `720p` / `1080p`，缺省 `720p`；**2.5 传 4k 直接 400** | 恒发，最高 1080p |
| `duration` | integer | 是 | **4~30 整数秒**（2.0 为 4~15），不接受 `-1` | 已 clamp + 补默认 |
| `callback_url` | string | 否 | http(s) 回调地址 | 未使用（走轮询） |
| `tools` | array | 否 | `[{"type":"web_search"}]` 开联网搜索 | 未接入 |
| `seed` / `watermark` / `generate_audio` / `service_tier` / `draft` / `return_last_frame` / `camera_fixed` | — | — | 上游「收下但不生效」（视频恒有声、无水印） | 灵智渠道已剥离 |
| `omni_reference_task_type` | string | — | 火山字段，灵智文档无对应实现 | 灵智渠道已剥离（后端 + 前端） |
| `asset://` / `draft_task` | — | — | **不支持**；素材请传公网可访问 URL | 已拦截 asset:// |

### 3. content 角色规则（与画布约束的差异）

| 规则（文档） | 画布实现 | 结论 |
| --- | --- | --- |
| `text` 0~1，纯文生必填，带素材可省 | 恒带一条 text（提示词非空才能提交） | 兼容 |
| `first_frame` 0~1，role 不填也当首帧 | 显式 `role=first_frame` | 兼容 |
| `last_frame` 0~1，**必须与 first_frame 同传** | 原先只检查模型是否支持尾帧 | **已修**：只给尾帧时本地拦截 |
| `reference_image` 0~30，与 first/last **不能混用**（除非同时带参考视频/音频走全能参考） | 首尾帧与参考素材一律互斥 | 画布**从严**，见第四节 |
| `reference_video` 0~10，出现即全能参考 | 2.5 上限 10；单个 2~30 秒、总 ≤30 秒 | 已对齐 |
| `reference_audio` 0~10，出现即全能参考 | 2.5 上限 10；2.0 不支持仅音频 | 已对齐 |

素材上限对照：

| 项 | 2.5 按秒 | 2.0 按秒 |
| --- | --- | --- |
| 参考图 | 0~30 | 0~9 |
| 参考视频 | 0~10，单个 2~30 秒，总 ≤30 秒 | 0~3，单个 2~15 秒，总 ≤15 秒 |
| 参考音频 | 0~10，总 ≤30 秒，**支持仅音频** | 0~3，总 ≤15 秒，**不支持仅音频** |
| 时长 | 4~30 秒 | 4~15 秒 |
| 分辨率 | 480p / 720p / 1080p | 480p / 720p / 1080p / 4K |

### 4. 响应

创建：`{"id": "99936297"}`

查询（进行中 / 完成 / 失败同一结构，`content` 仅成功时存在）：

```json
{
  "id": "99936297",
  "model": "doubao-seedance-2-5-260628",
  "status": "queued | running | succeeded | failed",
  "error": null,
  "content": { "video_url": "https://...（平台永久地址）" },
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "usage": { "completion_tokens": 0, "total_tokens": 0, "output_seconds": 5 },
  "framespersecond": 24,
  "generate_audio": true,
  "seed": -1,
  "service_tier": "default",
  "execution_expires_after": 172800,
  "created_at": 1788463493,
  "updated_at": 1788463751
}
```

- 画布读 `id` / `status` / `content.video_url` / `error.message` / `duration`，对称。
- `status=succeeded` 已在完成态枚举内；`queued` 归排队；`failed` 且带 `error` 会落库为失败原因。
- 产物是**永久地址**，`isAnmiaoBaseUrl` 分支已跳过 24 小时转存。
- 轮询间隔：画布 5 秒，落在文档建议的 5~10 秒内。

### 5. 错误码

HTTP 层（创建 / 查询）：

| HTTP | body | 含义 | 画布处理 |
| --- | --- | --- | --- |
| 401 | `{"error":{"code":"missing_api_key","message":"缺少 API key…","type":"authentication_error"}}` | 未带密钥 | 转中文：去渠道填 sk- 密钥 |
| 401 | `{"error":{"code":"invalid_api_key","message":"API key 无效","type":"authentication_error"}}` | 密钥无效 | 同上 |
| 400 | `{"error":{"code":"InvalidParameter","message":"…","param":"","type":"BadRequest"}}` | 参数越界（4k / 时长 / 比例 / 素材） | 保留 code，附参数范围提示 |
| 404 | `{"error":{"message":"未找到接口路径 …","type":"not_found"}}` | 域名或路径错（注意没有 `code`） | 提示检查 Base URL 是否带 `/anmiao` |

任务层（HTTP 200，`status=failed`）：

```json
{"status":"failed","error":{"code":"SensitiveContentDetected","message":"输入内容未通过内容审核…"}}
```

- 画布把 `error.message` 落成失败原因，前端命中 `SensitiveContent` 会追加「更换素材」提示。
- **失败任务上游已自动退款**，画布侧是否退算力点见第四节。

---

## 三、逐项对照与影响

| # | 接口 / 字段 | 文档要求 | 画布原实现 | 影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | Base URL 域名 | `api.lk888.ai` / `api.lingkeai.ai` | 未拦文档站 `lk666.ai`（HTML 200） | 只看到「没有返回任务 ID」，无法定位 | 已修：代理层拦截 |
| 2 | `model` | 火山真名 `doubao-*` | 未配映射时原样发 SKU | 上游 400；后台「测试渠道」却显示通过 | 已修：本地拦截并提示配映射 |
| 3 | `duration` 类型 | integer | 可能发 `8.7` | 强校验拒绝 | 已修：截断 |
| 4 | `duration` 缺失 | 必填 | 可能不带 | 400 | 已修：补 5 秒 |
| 5 | `duration` 范围 | 4~30（2.5）/ 4~15（2.0） | 只处理 `-1` | 60 秒直接 400 | 已修：按型号收敛 |
| 6 | `duration` 枚举（UI） | 4~30 每个整数 | 仅 10 个档位 | 选不到 7/9/11…29 秒 | 已修：逐秒 |
| 7 | 参考视频时长（UI） | 2.5：单个 2~30、总 30 | 写死 2~15、总 15 | 合法素材被拦 | 已修：按型号 |
| 8 | 素材数量（UI） | 2.5：图 30 / 视频 10 / 音频 10 | 统一 9 / 3 / 3 | 传不到协议允许数量 | 已修：按型号 |
| 9 | 仅传音频 | 2.5 支持，2.0 不支持 | 无差别放行 | 2.0 只传音频才 400 | 已修：非 2.5 提前拦 |
| 10 | `last_frame` | 必须与 `first_frame` 同传 | 未校验 | 只给尾帧必 400 | 已修：本地拦截 |
| 11 | `omni_reference_task_type` | 灵智无实现 | 后端剥离，本地直连仍发 | 本地直连可能被拒 | 已修：前端同步剥离 |
| 12 | 错误信封 | `code` + `param` + `type` | 只取 `message` | 分不清改密钥 / 改参数 / 改地址 | 已修：保留码 + 指引 |
| 13 | 错误文案 | 渠道中立 | 写死「火山方舟」 | 灵智渠道下指向错控制台 | 已修：改中立 |
| 14 | `tools`（联网搜索） | 可选 | 无开关 | 能力缺失 | 未接入 |
| 15 | 4K（2.0 按秒） | 支持 | 最高 1080p（2.5 本就无 4k） | 能力收窄，不报错 | 未开放 |
| 16 | `callback_url` | 可选 | 走轮询 | 无影响 | 不接入 |
| 17 | 失败自动退款 | 上游已退 | 画布侧无退款逻辑 | 上游失败 → 用户算力点照扣 | **待决策** |

---

## 四、待决策 / 风险

1. **失败任务退款（P1，需你拍板）**：文档明确「failed 的任务已自动退款」，而画布在 `UpdateVideoTaskFromPoll`
   把任务置为 failed 时不会退还算力点。要么补一条「失败自动退」并做幂等，要么在界面上写明「上游失败不退点」。
   涉及计费口径，未擅自改。
2. **首尾帧与参考素材混用**：文档允许「reference_image + first/last **且** 同时带参考视频/音频」走全能参考；
   画布目前一律互斥（火山官方口径）。这是**画布从严**，不会报错，但会少一种玩法。要放宽需单独开一类「全能参考」提交路径。
3. **Base64 素材**：文档写「素材请传公网可访问的 URL」，未承诺 Base64 内联。画布在上传转存失败时会退化成
   Base64（火山官方允许）。灵智通道下这条兜底未经实测，建议保持 `PUBLIC_BASE_URL` 可用，别依赖 Base64。
4. **提示词尾部参数**：灵智同样识别火山的 `--rs` / `--rt` / `--dur`。若用户提示词里写了这些，会覆盖 UI 的
   分辨率 / 比例 / 时长，表现为「设置没生效」。当前不做剥离，只在此记录。

---

## 五、推荐渠道配置

```text
协议：ark
Base URL：https://api.lk888.ai/api/v3/anmiao
API Key：sk-xxx（灵智控制台签发）
模型：seedance-2.5-guanfang-anmiao
模型名映射：seedance-2.5-guanfang-anmiao = doubao-seedance-2-5-260628
```

- 只填 SKU 不填映射 → 视频生成会被本地直接拦下并提示（后台「测试渠道」不发真实视频请求，别拿它当验收）。
- 想用 2.0 按秒：`seedance-2.0-guanfang-anmiao = doubao-seedance-2-0-260128`（时长上限自动降到 15 秒、素材上限 9/3/3）。
- 计费口径：上游按「秒 × 档位单价」扣，带参考视频时 MC-S 线整单 ×1.5、官方特惠线另收参考视频费；
  后台 `modelCosts` 是自己的算力点，别按火山 token 口径估。
