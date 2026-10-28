# 提交链路故障分析与修复方案

> 2026-10-28　基于 `infinite-canvas` 仓库实际代码核查
> 关联版本：v0.10.4 ~ v0.10.8

## 0. 先澄清一个前提：这是两套部署

| | 我们维护的线上 | 冬导操作的环境 |
|---|---|---|
| 地址 | `https://huabu.leohome.site`（Tailscale `100.71.150.13`） | `http://192.168.4.225:3000` |
| 可达性 | 本机可连 | **不可达**（不同网段） |
| 代码来源 | `git reset --hard origin/main` | 手工改文件 |

**结论：冬导做的改动没有进入 git 仓库，也没有出现在我们的线上。** 核查依据：

- `web/src/app/api/[...path]/route.ts` 的文件时间戳仍是 `Aug 22 21:03`（上游原版提交时间），内容里**没有** `headers.delete("expect")`、**没有** undici dispatcher
- 仓库里**不存在** `patches/` 目录
- `git log` 最新是 `ea98bf7 v0.10.8`，工作区干净

这解释了一个关键疑问：为什么"修好了"但用户那边仍然不行——**修的是另一台机器**。

另外要纠正冬导描述的一处历史：他说"v0.10.7 有 dispatcher，v0.10.8 弄丢了"。在我们仓库里 `route.ts` **从来没有被修改过**，v0.10.7 和 v0.10.8 的 `route.ts` 完全相同。他描述的应该是他自己手动改动的时间线。

---

## 1. 问题清单

按优先级排列。"是否我们线上存在"一列是实际核查结果，不是推测。

### P0-1　查不到任务时返回假的 `queued`，失败永远不可见

| 项 | 内容 |
|---|---|
| 位置 | `handler/ai.go` `AIVideo()` 第 71–74 行 |
| 是否存在 | **存在**，是当前"卡在 0%"最直接的原因 |
| 成因 | 前端提交前会先造一个本地占位号 `client_video_task_<nanoId>` 并立即开始轮询，此时后端可能还没入库。为兼容这个时间差，代码在查不到任务时**无条件**返回 `{"status":"queued","progress":0}` |
| 影响 | 一旦提交请求根本没到后端（代理断了/网络失败），这个占位任务永远查不到，于是**永远返回 queued**。前端拿到的是合法响应，既不重试也不报错，节点无限转圈。排查时后端日志干干净净，因为**根本没收到提交** |

代码现状：

```go
// handler/ai.go:65-76
func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	if serveAIVideoTask(w, r, id) {   // 按 id 查库，查不到返回 false
		return
	}
	if isClientVideoTaskID(id) {      // 占位号 → 无条件吐 queued
		OK(w, map[string]any{"id": id, "task_id": id, "object": "video", "status": "queued", "progress": 0})
		return
	}
	proxyAIGetRequest(w, r, "/videos/"+id)
}
```

`serveAIVideoTask` 只按 `id` 查 `video_tasks` 表（`handler/video_task.go:221`），没有 source 维度的兜底。提交成功时入库主键就是 `clientTaskId`，所以能查到；提交失败时表里什么都没有。

### P0-2　Next 代理层用流式转发，大请求体易被 undici 超时切断

| 项 | 内容 |
|---|---|
| 位置 | `web/src/app/api/[...path]/route.ts` 第 35–41 行 |
| 是否存在 | **存在**（原版代码），线上 72 小时内 `BodyTimeoutError` 9 次 |
| 成因 | `body: request.body` + `duplex: "half"` 把浏览器上传做成流式透传。undici 默认 `bodyTimeout` 300 秒，上传慢或图大时被切；`maxDuration = 300` 也压在同一档 |
| 影响 | 请求死在 3000 这一跳，后端一条日志都收不到，前端只看到 502 或挂起。**图越大越必挂**，正好对上"小图能过、12MB 必挂" |

代码现状：

```ts
// web/src/app/api/[...path]/route.ts:28-52
export const maxDuration = 300;
...
const response = await fetch(target, {
    method: request.method,
    headers: proxyHeaders(request),
    body: hasBody ? request.body : undefined,   // 流式
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
});
```

### P1-1　`Expect: 100-continue` 未剔除，Safari 发大 body 直接 502

| 项 | 内容 |
|---|---|
| 位置 | 同 `route.ts` 的 `proxyHeaders()`（第 10–18 行） |
| 是否存在 | 代码缺失**存在**；线上实际触发 **0 次**（当前用户用 Edge，不带这个头） |
| 成因 | 浏览器（主要是 Safari）在请求体较大时先发 `Expect: 100-continue` 等服务器确认。Node 的 undici 不支持，抛 `UND_ERR_NOT_SUPPORTED` |
| 影响 | 一旦换 Safari / 部分安卓浏览器，所有大 body 提交直接 502，且报错文案是"接口连接失败，请确认后端服务已启动"，完全指错方向 |

### P1-2　SSE 长连接被 300 秒切断（非核心，但污染日志）

| 项 | 内容 |
|---|---|
| 位置 | 同 `route.ts`（同一个 fetch 的响应侧超时） |
| 是否存在 | 存在，是那 9 次 `BodyTimeoutError` 的主要来源 |
| 成因 | 实时同步走 SSE，连接需要长时间保持，而 undici 默认 bodyTimeout 300 秒 |
| 影响 | 每 5 分钟断一次，前端靠重连恢复，功能上可接受，但日志噪音大、掩盖真正的问题 |

### P2-1　前端占位任务号在提交失败时没有回滚

| 项 | 内容 |
|---|---|
| 位置 | `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`（4366、4433 行等） |
| 是否存在 | 存在 |
| 成因 | 先把节点置为 loading 并写入占位 `videoTaskId`，再 `await` 提交。若 fetch 挂起（既不 resolve 也不 reject），`catch` 不执行，节点永远停在 loading |
| 影响 | 与 P0-1 叠加，形成"永远转圈且无提示"。单独修 P0-1 即可让这种情况变成明确报错，本条属加固 |

### P2-2　旧页面持续打不存在的接口，污染日志

| 项 | 内容 |
|---|---|
| 位置 | 无（不是现有代码发的） |
| 是否存在 | 我们线上**未观察到**；冬导环境有 5240 次 `/api/v1/info` 404 |
| 已核查 | 后端无此路由、前端源码与产物均无此路径 |
| 影响 | 只是日志噪音，不影响功能。成因是还开着旧版本页面。处理方式：关标签页即可，无需改代码 |

---

## 2. 已修复项回顾（避免重复劳动）

| 版本 | 修的问题 | 与本次故障的关系 |
|---|---|---|
| v0.10.4 | 选渠道时认「模型名映射」的上游真名 | 前置依赖 |
| v0.10.5 | 视频状态解析没解 `{code,msg,data}` 信封 + `task_id`/`id` 取反 | **修掉了一部分"卡 0%"**，但只覆盖"任务已入库、状态是 failed"的场景 |
| v0.10.6 | 生图参考图前端压缩 | 前端方案，实测未生效（旧 chunk） |
| v0.10.7 | 生图参考图改后端压缩 | 有效，已验证 16.70MB → 2.08MB 出图成功 |
| v0.10.8 | 灵智视频参考图 10MB（解码后）限制 | 有效，26.80MB PNG → 2.89MB |

**v0.10.8 的压缩本身没问题，但如果提交请求根本没到后端，压缩就没有执行机会。** 这就是"装了 v0.10.8 还是不行"的原因——不是压缩失效，是请求死在代理这一跳。

---

## 3. 修复方案

### 原则

**先可观测，再优化。** 当前最大的问题不是"某次提交失败"，而是**失败时系统不告诉你**。所以第一步让失败可见，而不是先去调超时参数。

### 第 1 步（P0，必须做）：让占位任务不再撒谎

改动 `handler/ai.go`，给占位号加宽限期，超期明确报错。

```go
func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	if serveAIVideoTask(w, r, id) {
		return
	}
	if isClientVideoTaskID(id) {
		// 占位号允许一段宽限期：提交与入库之间有时间差，立即 404 会误报。
		// 宽限期过后仍查不到，说明这次提交根本没到后端——必须明确报错，
		// 否则前端会永远轮询到一个假的 queued，用户只看到「正在创作 0%」。
		if clientVideoTaskWithinGrace(id) {
			OK(w, map[string]any{"id": id, "task_id": id, "object": "video", "status": "queued", "progress": 0})
			return
		}
		Fail(w, "视频任务没有创建成功：后端没有收到这次提交，请检查网络后重试")
		return
	}
	proxyAIGetRequest(w, r, "/videos/"+id)
}
```

宽限期判定放在 `handler/video_task.go`：

```go
// 占位号里带毫秒时间戳（形如 client_video_task_video-1793064095329-aqpwg），
// 优先用它判断;nanoid 形态取不到时间戳时用进程内首次查询时间兜底。
const clientVideoTaskGrace = 90 * time.Second

var clientVideoTaskFirstSeen sync.Map // id -> time.Time

func clientVideoTaskWithinGrace(id string) bool {
	if ts, ok := clientVideoTaskTimestamp(id); ok {
		return time.Since(time.UnixMilli(ts)) < clientVideoTaskGrace
	}
	now := time.Now()
	actual, loaded := clientVideoTaskFirstSeen.LoadOrStore(id, now)
	if !loaded {
		return true
	}
	return now.Sub(actual.(time.Time)) < clientVideoTaskGrace
}
```

要点：
- 90 秒宽限期要大于"正常提交 + 入库"的耗时（实测提交 3~10 秒，留足余量）
- 报错文案要写清"后端没收到"，直接指向代理层，不含糊成"接口失败"
- `Fail()` 走现在的信封，前端 `canvasVideoTaskFailed` 能识别（v0.10.5 已修解析）

### 第 2 步（P0）：代理层不再流式透传 + 剔除 Expect

同一处解决 P0-2 和 P1-1。核心是**请求体整体缓冲后再转发**，绕开整类流式中断。

```ts
function proxyHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");   // 交给 undici 按实际 body 重算
    headers.delete("connection");
    // Safari 在大 body 时会带 Expect: 100-continue，undici 不支持，
    // 不剔除会直接 UND_ERR_NOT_SUPPORTED → 502，且报错文案完全指错方向。
    headers.delete("expect");
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return headers;
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
        // 整体缓冲再转发：流式（duplex:"half"）时大 body 迟迟不流动，
        // undici 的 bodyTimeout 会在中途切断，后端连请求都收不到。
        const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
        const response = await fetch(target, {
            method: request.method,
            headers: proxyHeaders(request),
            body,
            redirect: "manual",
        });
        ...
```

**不要手动设 `content-length`**：`proxyHeaders` 已删掉它，undici 会按 Buffer 长度自动算。手动设会和实际 body 冲突，触发 `invalid content-length header`。

响应侧保持流式（`response.body`），否则 SSE 用不了。

### 第 3 步（P1，可选）：SSE 超时

如果第 2 步之后 SSE 仍每 5 分钟断，再处理。两个方向：

- **A（小改）**：只对 `/agent/events` 走独立分支，用 Node 原生 `http.request` 转发，超时设 0（不限制）
- **B（不推荐）**：整体换原生 `http` 写代理。改动面大，收益有限——SSE 断了会自动重连，不影响核心功能

建议先不做。**第 2 步的 body 缓冲不影响响应流式，SSE 该断还是会断，但它只影响实时同步的及时性。**

### 第 4 步（P2）：前端占位号回滚

`canvas-client-page.tsx` 的 `catch` 已会把节点置 error，问题只在"fetch 挂起不返回"时 `catch` 不触发。有了第 1 步的后端 404，前端一定能拿到响应，这条路自然通。**可以先不动**。

---

## 4. 关于 patches/ 方案：我不建议这么做

冬导的方案是「把 route.ts 的修改外置成 `patches/route.local.ts` + `apply.sh`，start.sh 启动前自动套用」。

**问题**：这是用脚本绕开版本控制，比直接提交进 git 更脆弱——

- `apply.sh` 失败时不会有任何提示，补丁静默丢失（正是这次故障的成因）
- 本地开发时看到的是仓库里的原版，和线上行为不一致
- 每次 `git reset` 后要在构建前抢着 apply，时序容易错

**建议直接提交进仓库。** 理由是：

1. 这些改动是我们长期要的，不是临时补丁
2. 我们是 fork（`mine` = `huahuazi/infinite-canvas`），改自己的 main 没有上游冲突问题
3. `git reset --hard origin/main` 部署时，提交进仓库的改动**天然不会丢**；而 patches 每多一个环节就多一次静默失败的机会

如果担心以后同步上游代码时冲突，正确做法是**把改动做成有注释的独立提交**，冲突时能看清意图，而不是藏在一个 apply 脚本里。

---

## 5. 验证方法

### 5.1 验证"失败可见"（第 1 步）

不需要真的弄断网络，直接用一个不存在的占位号查：

```bash
# 刚造的占位号 → 应返回 queued（宽限期内）
curl -s "https://huabu.leohome.site/api/v1/videos/client_video_task_video-$(date +%s)000-test" \
  -H "Authorization: Bearer <token>"

# 取一个 2 分钟前的占位号 → 应返回明确错误
curl -s "https://huabu.leohome.site/api/v1/videos/client_video_task_video-$(( $(date +%s) - 120 ))000-test" \
  -H "Authorization: Bearer <token>"
```

期望：前者 `status: queued`，后者 `code != 0` 且 msg 含「后端没有收到这次提交」。

### 5.2 验证代理层（第 2 步）

关键指标是**后端能不能收到 POST**，而不是前端界面表现。

```bash
# 1) 造一张大图（20MB 以上）
# 2) 从浏览器提交，同时盯后端日志
ssh leo@100.71.150.13 'cd ~/infinite-canvas && docker compose logs -f app | grep "POST.*videos"'
```

判断标准：

- 后端出现 `POST /api/v1/videos` → 代理这一跳通了
- `ai-calls` 日志里 `files[0].size` 明显小于原图 → 后端压缩生效
- 前端节点在 90 秒内要么成功、要么明确报错，**不再无限转圈**

### 5.3 验证 Expect 头（第 2 步附带）

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://huabu.leohome.site/api/v1/canvas/image-tasks" \
  -H "Expect: 100-continue" \
  -H "Authorization: Bearer <token>" \
  -F "model=gpt-image-2" -F "prompt=test" -F "image=@/tmp/small.jpg"
```

期望返回 200/400（业务错误），**不是 502**。

### 5.4 三个必须留证的现象

改完后如果还有问题，这三种日志能立刻定位，不用再猜：

| 现象 | 含义 |
|---|---|
| 后端无 `POST /api/v1/videos` | 死在代理层（看 Next 容器日志） |
| 后端有 POST，但 `ai-calls` 无记录 | 死在渠道选择/请求构造（看 `AI video select channel failed`） |
| 后端有 POST + `ai-calls` 有 400 | 上游拒了，看 `responseBody` 里的真实原因 |

---

## 6. 执行顺序与风险

| 步骤 | 风险 | 可否单独上线 |
|---|---|---|
| 1. 占位号宽限期 + 404 | 低（只影响查不到的分支） | 可，建议先上 |
| 2. 代理层缓冲 + 剔除 expect | **中高**（所有 API 都走这里） | 可，但必须先在本地跑一遍登录/生图/生视频/SSE 四条链路 |
| 3. SSE 独立超时 | 中 | 视 2 之后的表现决定 |
| 4. 前端占位号回滚 | 低 | 可不做（1 已覆盖） |

第 2 步的风险点：`request.arrayBuffer()` 会把整个请求体读进内存。当前是单用户场景，最大请求体约 64MB，可接受；如果以后要支撑并发大文件，应改成"小 body 缓冲 + 大 body 直接流式直连后端"的分流策略。

---

## 7. 一句话总结

**v0.10.8 的压缩是对的，但它在后端，而请求死在前端与后端之间的代理跳。** 真正要修的是两件：

1. 代理层别再用流式透传（P0-2），顺手剔除 `Expect`（P1-1）
2. 后端别再对查不到的占位任务撒谎说「排队中」（P0-1）

第 2 条比第 1 条更重要——它决定下次出问题时，你是能一眼看到报错，还是又要点开一堆日志去猜。
