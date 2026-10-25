# 白模 / 深度能力：模型层 vs 系统层

> 评估对象：infinite-canvas v0.9.x 的画布视频节点
> 结论时间：2026-10-25

---

## 一、先纠正一个前提

「白模 / 深度不是 Seedance 专属，几乎所有视频生成模型都具备」——这句话**一半对，一半是错觉**。

| 层面 | 产出是什么 | 是否普遍具备 | 能力来源 |
| --- | --- | --- | --- |
| **视觉风格** | 一段「看起来像白模 / 像深度图」的视频 | ✅ 基本都行，提示词到位就能画 | 生成模型（i2v / edit / reference） |
| **几何数据** | 逐帧真实深度值、法线、点云 | ❌ 没有任何生成模型会输出 | 独立的估计器（inverse rendering） |

这个区别是全部架构分歧的起点：

- 生成模型做的是**「画一张像深度图的图」**，它不理解前后景的真实距离，物体内部深度会跳、帧间会闪，值域也不可量测；
- 深度估计模型做的是**「算每个像素离镜头多远」**，输出可以导进 Blender / Nuke / ComfyUI 当 ControlNet。

所以真正的问题不是「哪些模型支持白模」，而是**「这个系统要不要具备几何提取能力」**。
如果要，就必须引入与生成模型无关的引擎；如果不要，那系统层只需要做**提示词编排 + 能力路由**，任何视频模型都能挂上去。

---

## 二、两种方案的实质差异

| 维度 | 模型层实现（当前） | 系统层实现 |
| --- | --- | --- |
| 能力归属 | 依附于某个模型的 `edit` / `reference` 子任务 | 独立的「视频派生」服务，与模型解耦 |
| 换模型 | 参数适配要重写；渠道不同行为不同（灵智拒 -1、Flatkey 过滤 -1） | 换引擎只换一个 provider，上层无感 |
| 精度 | 视觉级，轮廓漂移、帧间闪烁 | 几何级，深度可量测、时序稳定 |
| 成本结构 | 按秒计费，随视频长度线性增长 | 一次性算力，边际成本≈电费 |
| 延迟 | 分钟级（排队 + 生成） | 秒级~分钟级（取决于算力） |
| 合规 | 参考视频必须是公网 URL，素材必然出网 | 浏览器端可完全不出本机 |
| 可复用性 | 只能「看」 | 可导出序列做后期、做 ControlNet 输入 |
| 失败模式 | 上游参数校验 / 内容审核 / 排队超时 | 模型加载失败、显存不足、浏览器兼容 |
| 工程成本 | 1 天（已完成） | 浏览器端 2~3 天；服务端 1 周起（需 GPU） |

**一句话**：模型层买的是「快和便宜的上手」，系统层买的是「可控和可复用」。两者不是替代关系。

---

## 三、建议的系统层架构

### 3.1 分层

```
UI 入口（视频节点右键 / 批量派生）
   ↓  统一契约：derive(source, mode, quality) → DeriveResult
派生编排器 Orchestrator
   ├─ 能力探测：当前部署 + 当前渠道有哪些引擎可用
   ├─ 路由：按 mode（clay/depth）+ quality（preview/standard/high）+ 成本偏好选引擎
   ├─ 参数适配：统一参数 → 各引擎私有参数（duration / ratio / 分辨率 / 帧率）
   └─ 产物登记：写 VideoTask，标记 engine / engineVersion / params
   ↓
引擎层（同一接口，可插拔）
   ├─ generative-ark      视觉版，调任意支持 edit/reference 的视频模型
   ├─ generative-openai   视觉版，走通用 /videos 接口的模型
   ├─ geometry-browser    浏览器 onnx（Depth Anything V2 / DSINE），零服务端算力
   ├─ geometry-server     ffmpeg + onnxruntime，需 GPU 或高配 CPU
   └─ geometry-api        第三方深度 API（默认关闭，素材出网）
```

### 3.2 接口草案

```ts
export type DeriveMode = "clay" | "depth";
export type DeriveQuality = "preview" | "standard" | "high";

export type DeriveSource = {
    /** 源视频：画布节点 / 素材库 / 本地文件统一成这个形状 */
    url?: string;
    storageKey?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    mimeType?: string;
};

export type DeriveResult = {
    videoUrl: string;
    storageKey?: string;
    /** 几何引擎才有：逐帧深度序列（可选导出） */
    sequence?: { kind: "depth" | "normal"; frames: string[] };
    meta: {
        engine: string;
        engineVersion: string;
        mode: DeriveMode;
        quality: DeriveQuality;
        params: Record<string, unknown>;
        /** 深度范围，给下游归一化用 */
        depthRange?: { min: number; max: number };
    };
};

export type DeriveEngine = {
    id: string;
    supports: (mode: DeriveMode, quality: DeriveQuality) => boolean;
    /** 本地预检：返回 null 表示可提交 */
    precheck?: (source: DeriveSource, ctx: DeriveContext) => string | null;
    run: (source: DeriveSource, opts: DeriveOptions, ctx: DeriveContext) => Promise<DeriveResult>;
};
```

编排器的核心逻辑只有三步：**过滤可用引擎 → 按质量与成本排序 → 依次尝试并降级**。
上层 UI 不需要知道背后是 Seedance 还是 Depth Anything。

### 3.3 为什么要保留「模型层」这一路

几何引擎有硬门槛（算力、模型体积、浏览器兼容），模型层是**唯一的零门槛兜底**：
新用户第一次点「白模」，几何引擎还没就绪时，能立刻出一条视觉版，而不是转圈等模型下载。

所以正确姿势是**双引擎并存 + 质量分级**，不是二选一。

---

## 四、约束条件（做之前必须认的）

| # | 约束 | 影响 | 对策 |
| --- | --- | --- | --- |
| 1 | **渠道能力靠猜**：当前是硬编码黑名单（灵智 / Flatkey / KIE / APIMart / Gemini） | 每加一个渠道就要改代码，容易漏 | 改成后台渠道配置里的「能力声明」：勾选 `支持视频编辑`，前端只读声明 |
| 2 | **edit 类任务参数互斥**：`ratio=adaptive` + `duration=-1` 是硬要求，而中转站普遍拒 -1 | 中转渠道做不了 | 编排层按引擎 clamp，不做跨渠道复用 |
| 3 | **编码容器不统一**：浏览器 `MediaRecorder` 只能出 webm，`WebCodecs` 才能出 mp4 | 产物格式不一致，下载/剪辑体验差 | 统一走 WebCodecs + mp4-muxer；不支持时降级 webm 并标注 |
| 4 | **帧率与时长**：逐帧推理耗时随帧数线性增长，30 秒 24fps = 720 帧 | 浏览器端可能跑到 5 分钟 | 默认降采样到 12~16fps 推理，再插值回原帧率；给「预览 / 标准」两档 |
| 5 | **模型体积**：Depth Anything V2 Small fp16 ≈ 50MB | 首次加载慢，国内拉 HuggingFace 可能失败 | 模型文件自托管到 `/public/models`，走自己的域名；带进度条与缓存 |
| 6 | **白模质量的天花板**：从深度反投影求法线，边缘噪声大 | 白模会比深度差 | 白模单独用法线估计模型（DSINE / Metric3D），或接受"接近但不精确" |
| 7 | **素材合规**：generative 引擎必须公网回源，素材必然出网 | 银行客户素材不可接受 | 几何引擎默认本地；generative 明确提示"素材将上传至公网" |
| 8 | **产物归档**：派生视频会重复生成，重复烧钱 | 成本失控 | 以 `源视频 hash + mode + 参数` 做缓存键，命中直接复用 |
| 9 | **可追溯性**：几何结果是"估计值"，不能当量测 | 误用风险 | 产物元数据记录 engine / 版本 / depthRange，并在 UI 标注 |

---

## 五、实施优先级

| 阶段 | 内容 | 价值 | 代价 |
| --- | --- | --- | --- |
| **P0（已完成）** | 模型层实现：Seedance `edit` 任务出视觉白模 / 深度 | 当天可用，零基础设施 | 1 天 |
| **P1** | 抽编排层 + 引擎接口，把现有实现降级为 `generative-ark`；黑名单改渠道能力声明 | 「加模型就能用」成立，不再绑死 Seedance | 1 天 |
| **P2** | `geometry-browser`：Depth Anything V2 Small + WebCodecs，输出真深度视频 + 序列 | 摆脱模型依赖，素材不出本机 | 2~3 天 |
| **P3** | 白模专用法线引擎（DSINE / Metric3D）、EXR/PNG 序列导出 | 可进 Blender / Nuke 管线 | 2 天 |
| **P4** | `geometry-server`：ffmpeg + onnxruntime，批量与长视频 | 不依赖用户浏览器性能 | 1 周，需 GPU |

**建议只做到 P2 就停**——P3/P4 只在真的要把产物导进三维管线时才值得投。

---

## 六、对现有代码的改造建议

1. `web/src/lib/video-derive.ts` 目前把「提示词 + 参数覆盖 + 渠道黑名单」混在一个文件里。
   P1 应拆成三块：`derive/presets.ts`（提示词）、`derive/engines/generative-ark.ts`（引擎实现）、`derive/orchestrator.ts`（路由与降级）。
2. `service/video_task.go` 的 `VideoTask` 表已经够用，加两个字段即可承载几何引擎：
   `Engine string`、`EngineParams string`（JSON），`Model` 留空或填 `local/depth-anything-v2`。
3. 前端 `videoDeriveSupportIssue()` 的黑名单要改成读渠道能力声明，
   否则以后每接一个中转站都要改一次前端。
4. 节点 `metadata.deriveKind` 建议扩成 `derive: { mode, engine, quality }`，
   这样同一张画布上可以同时存在「视觉白模」和「几何深度」，不会混淆。

---

## 七、结论

- **用户的判断方向是对的**：白模 / 深度作为产品能力，不该绑死在某个模型上。
- **但绑死的根因不是模型能力，而是系统没有几何引擎**。只要还在用生成模型，换谁都是「画得像」，换模型只是换了个画笔。
- **系统层的正确做法**是把「生成式风格转换」和「几何提取」拆成两类引擎，统一编排、按质量分级、可降级。
- **现实路径**：现有实现保留为 `generative` 兜底（P0 已完成）→ 抽编排层（P1）→ 上浏览器端几何引擎（P2）。到 P2 才算真正与模型解耦。
