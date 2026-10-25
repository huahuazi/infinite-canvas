# 白模 / 深度视频派生

> 适用版本：infinite-canvas v0.9.x（Seedance 2.5 / 2.0 + 火山方舟 Ark 协议）
> 结论时间：2026-10-25

---

## 一、它解决什么

画布上的视频节点右键 →「生成白模视频」/「生成深度视频」，
把实拍视频整体改写成**纯白素模**或**单通道深度图**，产出新的视频节点并自动连线。

用途：

- 白模：换材质 / 换场景重渲染时的结构底稿，或给客户看的素模预演；
- 深度：后期景深、视差、伪 3D，以及作为外部重绘工具的结构控制输入。

**重要区分**：这是**视觉级**的白模 / 深度，不是几何重建。
上游是把画面「画」成白模 / 深度图的样子，物体轮廓会有轻微漂移，
深度值也不是真实物理距离，**不能当作精确的 ControlNet depth 使用**。
要精确几何得换深度估计模型（见第六节）。

---

## 二、实现选型（已决策）

走火山的**视频编辑子任务**（`omni_reference_task_type=edit`），不新增任何后端能力：

```
视频节点（实拍）
   ↓ 右键「生成白模视频」
读取节点 content → arkReferenceVideoUrl（本地文件自动转公网直链）
   ↓
POST {ark}/contents/generations/tasks
{
  model: doubao-seedance-2-5-*,
  content: [
    { type: "text",      text: <内置提示词> },
    { type: "video_url", video_url: { url: <原视频直链> }, role: "reference_video" }
  ],
  ratio: "adaptive",                 ← edit 任务硬要求
  duration: -1,                      ← edit 任务硬要求
  omni_reference_task_type: "edit",
  generate_audio: false
}
   ↓ 新视频节点（loading）+ 连线到原节点
轮询 effect 自动接管（读 metadata.videoTaskId）
```

没有选「生成模型直接出白模 / 深度」以外的路径，是因为：
镜像里没有 ffmpeg，后端零视频处理能力；浏览器端 onnx 深度估计要 2~3 天工程量，
而当前需求只到「视觉参考」级别。

---

## 三、改动落点

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 提示词与参数适配 | `web/src/lib/video-derive.ts` | 两套提示词模板、`applyVideoDeriveConfig`（覆盖 ratio/duration/taskType）、`videoDeriveSupportIssue`（预检） |
| 右键菜单 | `web/src/app/(user)/canvas/components/canvas-context-menu.tsx` | 视频分支新增两个菜单项，`CanvasContextNodeActions` 增加 `deriveVideo` |
| 画布接线 | `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | `deriveVideoNode`：建节点 → 提交任务 → 失败回写；重试与「改提示词再生成」保留 edit 参数 |
| 节点类型 | `web/src/app/(user)/canvas/types.ts` | `CanvasNodeMetadata.deriveKind`，标记节点来源是白模还是深度 |

---

## 四、硬约束（改这块前必看）

火山官方对 `edit` 任务的要求，任何一条不满足都会报错：

| 约束 | 说明 | 代码处理 |
| --- | --- | --- |
| `ratio` 必须 `adaptive` | 传具体比例会被拒 | `applyVideoDeriveConfig` 强制覆盖 `size="adaptive"` |
| `duration` 必须 `-1` | 传具体秒数会被拒 | 覆盖 `videoSeconds="-1"`（非灵智通道才会保留 -1） |
| 参考视频 4~30 秒 | 太短太长都拒 | `videoDeriveSupportIssue` 按 `metadata.durationMs` 预检 |
| 提示词必须含编辑关键词 | 否则被判成「参考生视频」 | 模板里固定有「严格编辑 / 修改为 / 去掉」 |
| 用「视频1」直接指代 | 写「参考 视频1」会被误判为 reference | 模板已按此写 |
| 模型仅 Seedance 2.5 / 2.0 | 1.x 不支持参考视频 | 预检 `modelKey.includes("seedance-2")` |

**渠道差异**：

- **灵智按秒通道**：`duration=-1` 会被本地收敛成 5 秒，且该通道不承接编辑任务 → 直接拦下；
- **Flatkey**：本地会把 `duration=-1` 过滤掉，而 edit 必须传 -1 → 直接拦下；
- **云端渠道**：后端只做 model / baseUrl 改写，不改 `omni_reference_task_type`，可用。

---

## 五、提示词（要调效果就改这里）

两套模板在 `web/src/lib/video-derive.ts` 的 `VIDEO_DERIVE_PRESETS`。
调优方向：

- 白模太白/丢结构 → 加强「环境光遮蔽、接触阴影、结构转折」的描述；
- 白模不够干净 → 明确列出要「去掉」的东西（颜色、贴图、Logo、文字）；
- 深度图层级不清 → 强调「近白远黑、同一物体深度连续」，并删掉一切明暗描述；
- 出现字幕/水印 → 追加「无水印、无字幕、无文字」。

模板改完不需要动任何调用方。

---

## 六、后续可演进（未做）

| 方向 | 做法 | 代价 |
| --- | --- | --- |
| 真几何深度 | 浏览器端 `transformers.js` + Depth Anything V2 Small（onnx/WebGPU），逐帧推理后用 WebCodecs 合成 | 2~3 天；首次下载 ~50MB 模型；10 秒视频约 1~2 分钟 |
| 真白模（法线） | 深度反投影求法线 → 白色 Lambert 着色 | 依赖上一条 |
| 白模 → 重渲染闭环 | 白模视频作 `reference_video` + 主体参考图，`omni_reference_task_type=reference` | 半天；火山原生支持 |
| 服务端 ffmpeg | 抽帧 / 合成 / 转码下沉后端 | 镜像 +50MB，需要任务队列 |

---

## 七、验证清单

- [ ] 右键视频节点，能看到「生成白模视频」「生成深度视频」两项
- [ ] 点击后立刻出现 loading 的视频子节点，并连到原视频
- [ ] 选 Seedance 2.5 + 火山官方渠道，任务能创建成功（不报 `TaskTypeConstraint`）
- [ ] 选 Kling / 灵智 / Flatkey 时，弹出明确提示而不是提交后失败
- [ ] 原视频 < 4 秒或 > 30 秒时，本地直接拦下
- [ ] 白模节点上改提示词再生成，仍然是编辑任务（不退回参考生视频）
- [ ] 白模节点点「重试」，参数与首次一致
