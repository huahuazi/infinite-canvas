# 参考视频输入源：限制、影响与方案选型

> 适用版本：infinite-canvas v0.8.3（灵智 Anmiao / 火山方舟 Ark 通道）
> 结论时间：2026-10-25

---

## 一、先把限制说准

「必须公网直链」不是画布的任性要求，而是**上游协议**决定的：

- 火山方舟 / 灵智的 `content[]` 里，视频只能传 `video_url.url`，取值仅支持**公网可访问的 URL**（或账号级授权素材 `asset://`）。
- 图片、音频可以 Base64 内联，**视频不行**——这是硬约束，没有"把视频塞进请求体"的合规做法。
- 灵智明确不支持 `asset://`（中转站透传不了账号级授权），所以中转场景下**只剩公网 URL 一条路**。

再看画布现有链路（已经做了一半，不是从零）：

```
参考视频（本地文件 / 画布素材 / 粘贴链接）
   ↓ resolveMediaUrl / publicHttpUrl 判断是不是公网 http(s)
   ├─ 是 → 直接放进 content[].video_url.url
   └─ 否 → 读 blob → POST /api/v1/media/references（需登录）
            → 落盘 data/reference-media/<uuid>.mp4
            → 返回 {PUBLIC_BASE_URL}/api/media/references/<uuid>.mp4
   ↓ 火山 / 灵智 回源拉取这个 URL
```

关键代码：`web/src/services/api/video.ts` 的 `arkReferenceVideoUrl`、`uploadArkReferenceToPublicUrl`；后端 `handler/media_reference.go`。
当前服务器 `PUBLIC_BASE_URL=https://huabu.leohome.site`，域名 `A 123.156.4.152` + `AAAA` 双栈，公网可达，**所以本地上传这条路是通的**。

真正卡人的不是"要粘链接"，而是：**这条链接必须能被上游机房拉得动、拉得完、拉得安全**。

### 现在就能拿到直链的三条路径

| 路径 | 操作 | 产出的链接 | 前提 |
| --- | --- | --- | --- |
| 画布内上传（已内置） | 参考视频区上传文件 → 提交时自动转存 | `https://huabu.leohome.site/api/media/references/<uuid>.mp4` | `PUBLIC_BASE_URL` 公网可达（当前已配） |
| 对象存储手动传 | COS/OSS 控制台上传 → 复制对象地址（公共读）或生成临时签名 URL | `https://<bucket>.cos.ap-.../ref/xxx.mp4` | 桶允许公共读或签名未过期 |
| 自有静态目录 | `scp` 到 Caddy 静态根目录 | `https://huabu.leohome.site/ref/xxx.mp4` | Caddy 已映射该目录、文件在公网可读 |

直链要满足的条件（缺一不可）：

- 公网 **IPv4** 可达（纯 IPv6 域名火山拉不到）
- 无需 Cookie / Referer / UA 白名单，无防盗链
- `Content-Type: video/mp4`（或 `video/quicktime`），支持 `HEAD` 与 `Range`
- 单文件 ≤ 50MB、时长 2–30 秒（2.5）、总时长 ≤ 30 秒
- URL 里不要有中文与空格（需 URL 编码）


---

## 二、影响分析

### 1. 可用性（会直接失败）

| 场景 | 结果 | 用户看到 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` 未配置 | 本地上传直接 500 | 「参考素材转存失败：500」 |
| 填了内网地址（192.168/10.x） | 前端判断"通过"，上游拉不到 | 任务 failed 或长时间卡 running |
| 域名只有 AAAA（纯 IPv6） | 火山机房以 IPv4 为主，回源失败 | 同上 |
| 粘贴网盘 / 素材站链接 | 多数需要 Cookie / UA / 防盗链 | 上游 400 或拉取失败 |
| 视频超 50MB / 超 30 秒 | 本地就拦 | 提示明确，可接受 |

### 2. 性能与稳定性（最容易被低估）

- **双倍上行**：用户先把 150MB 传到服务器，火山再回源拉 150MB。同一条宽带上行被消耗两次。
- **冷启动慢**：20Mbps 上行下，50MB 单文件约 20 秒；2.5 允许 10 条参考视频、总 30 秒，一次任务素材轻松 200–500MB，**首个字节要等 1–3 分钟**，火山回源超时风险随体积线性上升。
- **并发互相挤占**：3 个任务同时跑，办公/家庭宽带的上行被拉满，画布 API 一起变慢。
- **重复下载**：每次生成都重新回源，不做服务端缓存。

### 3. 合规（银行场景必须提）

现状的媒体出口有三个硬伤：

1. `GET /api/media/references/:id` **无鉴权、无过期**，任何人拿到 URL 永久可看；
2. `Cache-Control: public, max-age=86400`，中间代理会缓存；
3. 上传的文件**永不清理**，`data/reference-media/` 只涨不降。

uuid 不可猜，但链接会出现在上游请求体、AI 调用日志、浏览器历史里。客户素材一旦泄露就是合规事故，**这一条比性能更值得先处理**。

### 4. 成本

自建出口的现金成本接近 0，成本体现在带宽与运维（单机磁盘、单点故障）。
对象存储按量：素材 150MB/任务、每天 10 个任务 ≈ 45GB/月流量，费用约 **20–30 元/月**；每天 50 个任务约 **100–150 元/月**。

### 5. 体验

用户分不清"本地文件"和"链接"的差别，报错又只有一句「参考素材转存失败」，于是反复重试。这是当前投诉成本最高的一环。

---

## 三、现有实现的 4 个具体缺陷（可直接修）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `web/src/services/api/video.ts` `publicHttpUrl` | 只挡 `localhost/127.0.0.1/::1`，**不挡 192.168/10/172.16-31/169.254/fc00::/7**，内网地址会被判成"公网" | 复用 `service/ssrf.go` 的 `isBlockedProxyIP` 逻辑，前后端各加一份私网判定 |
| 2 | `handler/media_reference.go` `ReferenceMedia` | 读取无鉴权、无过期 | 加签名参数（`?exp=&sig=`，HMAC + TTL 1 小时），过期返回 403 |
| 3 | 同上 | 素材永不清理 | 启动定时任务清理 24h 前的文件，或按天分目录轮转 |
| 4 | `uploadArkReferenceToPublicUrl` | 失败只抛「转存失败：500」，不区分未配置 / 超限 / 网络 | 按 HTTP 状态与后端 `msg` 分别给提示 |

---

## 四、方案对比

| 方案 | 稳定性 | 成本 | 部署难度 | 合规 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| **A. 加固现有自建出口**（签名 + TTL + 清理） | 中：受单机上行的带宽与单点限制 | 0 元 | 低（改 3 处代码 + 无需新依赖） | 中：可控 TTL，但数据仍在应用机 | 小团队、素材小、并发低；现状最快落地 |
| **B. 对象存储 + 预签名直传**（S3 兼容：COS/OSS/MinIO） | 高：云厂商回源、多副本、可挂 CDN | 20–150 元/月 | 中：后端加签名接口 + 前端直传，复用现有 S3 配置 | 高：私有桶 + 1 小时过期 + 生命周期删除 + 访问日志 | **推荐**：商业视频生产、多任务并发、要审计 |
| C. 内网穿透（Cloudflare Tunnel / frp / ngrok） | 低：免费隧道限速、掉线、被墙 | 0–50 元/月 | 低 | 低：流量过第三方 | 应急演示、临时联调 |
| D. 第三方视频床/图床 | 低：会转码、加水印、随时失效 | 0 元 | 低 | 很低：素材交给不明第三方 | 不建议 |
| E. 网盘 / 素材站直链 | 低：需 Cookie/UA、防盗链、限速 | 0 元 | 低 | 低 | 不建议 |
| F. 上游原生素材库 `asset://` | 高（官方直连时） | 按官方计费 | 中：需企业认证、素材与 Key 同账号 | 高 | 只用官方火山渠道、不用中转站时 |

### 替代输入方式（绕开"视频直链"）

| 方式 | 做法 | 代价 |
| --- | --- | --- |
| 抽帧当参考图 | ffmpeg 抽 1–3 帧 → `reference_image` / 首尾帧 | 丢失运动信息，只能控风格 |
| 首尾帧 | 首帧 + 尾帧两张图 | 构图可控，动作靠提示词 |
| 转码压缩 | ffmpeg → 720p / 30fps / ≤30s / ≤50MB | 画质下降，但能过限制 |
| Base64 内联 | 仅图片、音频支持 | 视频不支持，无解 |
| `asset://` 素材库 | 官方火山渠道上传素材库 | 灵智等中转不支持 |

---

## 五、推荐做法

**方案 B：S3 兼容对象存储 + 预签名直传**（云上用腾讯云 COS / 阿里 OSS，行内不许出网就用同代码接 MinIO）。

### 为什么是它

1. **解决稳定性根因**：素材由浏览器**直传云端**，不再经应用机中转；火山从云厂商机房回源，跨网质量远好于从办公/家庭宽带回源。上行只付一次（用户 → 云），不是两次。
2. **合规闭环**：私有桶 + 预签名 URL（TTL 1 小时）+ 生命周期规则（1 天自动删）+ 访问日志。这三点是"自建出口 + 永久链接"给不了的。
3. **成本可控**：按当前量级（10 任务/天）约 20–30 元/月，比一次事故便宜。
4. **改造成本低**：仓库已有 S3/WebDAV 存储抽象（`service/storage.go`、后台「存储」配置），只是缺"预签名"这一步；不需要引入新的基础设施概念。
5. **可回退**：设置 `REFERENCE_MEDIA_DRIVER=local|s3`，默认 `local` 保持现网不动；S3 配好再切。

### 落地清单（3 步）

1. **后端**：新增 `POST /api/v1/media/reference-tickets`
   - 入参：`filename` / `contentType` / `bytes`（可选 `durationMs`）
   - 校验：类型 mp4/mov、≤50MB、视频 2–30 秒
   - 输出：`{ uploadUrl（预签名 PUT，10 分钟）, publicUrl（预签名 GET，1 小时）, expiresIn }`
2. **前端**：`arkReferenceVideoUrl` 先取 ticket → `PUT` 直传 → 用 `publicUrl`；失败自动回退现有 `/api/v1/media/references`。
3. **运维**：桶设为私有 + 生命周期 1 天 + 只允许 `PUT/GET`；`PUBLIC_BASE_URL` 保留给 local 驱动与图片/音频兜底。

### 配套的"立刻能做"

上面第三节的 4 个缺陷建议一起修，尤其 **1（私网地址误判）** 和 **2（永久公开链接）**——不换方案也能显著降风险。

### 不建议

- 用内网穿透扛生产：免费隧道限速 + 掉线，出问题最难查。
- 用第三方视频床：转码/水印/失效三连，商业素材不可控。
- 把视频转 Base64：协议不支持，别浪费时间。

---

## 六、验收清单

- [ ] 断网/弱网下上传，报错能区分「未配置」「超限」「网络失败」
- [ ] `PUBLIC_BASE_URL` 填内网地址时，前端直接拦下并说明原因
- [ ] 预签名 URL 过期后访问返回 403，任务不受影响（火山在有效期内已拉完）
- [ ] 单任务 8 条参考视频（合计 ~200MB）提交后，首帧延迟 < 30 秒
- [ ] 素材 24 小时后自动清理，磁盘不再单调增长
- [ ] 切回 `local` 驱动后，原链路行为不变

---

## 附：外部上传服务清单（2026-10-25 实测）

> 说明：下表「本机可达」是从开发机直连（无代理）`curl -I` 的结果，**只能证明域名没被墙**，不能证明火山机房能拉到。
> 正式使用前必须用画布真跑一次生成验证。

| 服务 | 免费额度 | 直链形态 | 本机可达 | 合规 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 腾讯云 COS | 新用户试用（以官网为准） | `https://<bucket>.cos.<region>.myqcloud.com/xxx.mp4` | 400（域名正常） | 高（私有桶 + 签名 + 生命周期） | **推荐** |
| 阿里云 OSS | 新用户试用（以官网为准） | `https://<bucket>.oss-<region>.aliyuncs.com/xxx.mp4` | 404（域名正常） | 高 | 推荐 |
| 七牛云 Kodo | 约 10GB 存储，测试域名 30 天 | `http://<测试域名>/xxx.mp4` | 200 | 中（需备案域名才长期可用） | 可用 |
| 又拍云 | 联盟计划 | 自绑定域名 | — | 中 | 可用 |
| catbox.moe | 单文件 200MB，永久 | `https://files.catbox.moe/xxx.mp4` | 200 | **低**（公开、可被索引） | 仅临时验证 |
| litterbox.catbox.moe | 单文件 1GB，1h/12h/24h/72h | 同上（临时） | 405（HEAD 不支持，服务正常） | 低 | 仅临时验证 |
| 0x0.st | 单文件 512MB，保留 30–365 天 | `https://0x0.st/xxxx.mp4` | 200 | 低 | 仅临时验证 |
| tmpfiles.org | 100MB，约 1 小时 | `https://tmpfiles.org/dl/xxxx/xxx.mp4` | 200 | 低 | 仅临时验证 |
| uguu.se | 128MB，约 3 小时 | `https://uguu.se/xxxx.mp4` | 200 | 低 | 仅临时验证 |
| jsDelivr + GitHub | 单文件 ≤20MB | `https://cdn.jsdelivr.net/gh/<user>/<repo>@main/x.mp4` | 301（正常） | 低（仓库公开） | 不建议 |
| 百度/夸克/阿里云盘 | — | 需 Cookie / 防盗链 | — | — | **不可用** |
| B站 / YouTube | — | 非 mp4 直链 | — | — | **不可用** |

### 命令行上传示例（临时验证用）

```bash
# 0x0.st：一条命令，返回直链
curl -F "file=@ref.mp4" https://0x0.st

# catbox（永久，公开）
curl -F "reqtype=fileupload" -F "fileToUpload=@ref.mp4" https://catbox.moe/user/api.php

# 腾讯云 COS（需 coscmd / coscli）
coscmd upload ref.mp4 /ref/ref.mp4
coscmd signurl /ref/ref.mp4 3600      # 生成 1 小时有效的签名直链
```

### 验证直链是否"上游可拉"

```bash
curl -I "https://.../ref.mp4"
# 期望：HTTP/1.1 200、Content-Type: video/mp4、Accept-Ranges: bytes
# 再从服务器（不同出口）跑一次，排除本机网络假象
```

三条都过了，仍要在画布里真发一次任务才算验证完成——上游回源失败不会在 `curl` 阶段暴露。

---

## 七、已实现：公共直链镜像兜底

为「自建出口不可用」补了一条自动兜底链路，用户侧完全无感。

### 链路

```
参考视频（本地文件 / blob）
   ↓ 先试自建出口 POST /api/v1/media/references
   ├─ 成功 → 用 {PUBLIC_BASE_URL}/api/media/references/xxx
   └─ 失败 → POST /api/v1/media/public-mirror（multipart）
              → 后端按 PUBLIC_MIRROR_PROVIDERS 顺序尝试
              → catbox → 0x0.st → litterbox → tmpfiles
              → 任一成功即返回直链；全失败返回每个托管的原因
```

- 图片 / 音频**不会**走公共托管：它们可以 Base64 内联，仍由调用方回退，避免把可内联的素材推上公网。
- 生成结果（火山 24 小时链接）在本地转存失败时可镜像保活，但默认关闭（`PUBLIC_MIRROR_RESULTS=false`）。

### 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_MIRROR_MODE` | `fallback` | `fallback` 仅兜底；`off` 整体关闭 |
| `PUBLIC_MIRROR_PROVIDERS` | `catbox,0x0st,litterbox,tmpfiles` | 顺序即优先级，未知名字忽略 |
| `PUBLIC_MIRROR_RESULTS` | `false` | 是否允许镜像生成结果 |

### 交互

- 上传开始：结果卡片显示「正在为参考素材准备公网地址…」
- 自建出口失败：切换为「本机素材出口不可用，正在改用公共直链（…）…」
- 全部失败：抛错并列出 `托管名：原因`，用户能看到到底卡在哪一家
- 成功后状态自动清除，全程不需要额外交互

### 代码落点

| 层 | 文件 |
| --- | --- |
| 供应商与容错 | `service/public_mirror.go` |
| HTTP 入口（文件 / 远程地址两种） | `handler/public_mirror.go`，路由 `POST /api/v1/media/public-mirror` |
| 前端兜底与状态 | `web/src/services/api/video.ts`、`web/src/stores/use-media-mirror-store.ts` |
| 状态展示 | `web/src/app/(user)/video/page.tsx` 的 `PendingVideoCard` |
