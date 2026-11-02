export type ModelChannelProtocol = "openai" | "gemini" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "ark" | "anmiao" | "flatkey" | "a6api" | "wavespeed" | "huggingface";

export const modelChannelDefaultBaseUrls: Record<ModelChannelProtocol, string> = {
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
    grok2api: "",
    metaso: "https://metaso.cn/api/minimax",
    apimart: "https://api.apimart.ai/v1",
    kie: "https://api.kie.ai/api/v1",
    mimo: "https://api.xiaomimimo.com",
    ark: "https://ark.cn-beijing.volces.com/api/v3",
    anmiao: "https://api.lk888.ai/api/v3/anmiao",
    flatkey: "https://router.flatkey.ai/v1",
    a6api: "https://api.a6api.vip",
    wavespeed: "https://api.wavespeed.ai",
    huggingface: "https://depth-anything-video-depth-anything.hf.space",
};

export const modelChannelApiKeyUrls: Partial<Record<ModelChannelProtocol, string>> = {
    metaso: "https://metaso.cn/minimax-h3/?s=tt",
    apimart: "https://apimart.ai/register?aff=fWMrEv",
    mimo: "https://platform.xiaomimimo.com/?ref=JFZQR2",
    ark: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
    anmiao: "https://api.lk888.ai",
    wavespeed: "https://wavespeed.ai/accesskey",
    huggingface: "https://huggingface.co/settings/tokens",
};

// 火山方舟通道的提示信息，供后台渠道表单展示。
export const arkChannelTips = {
    baseUrl: "官方 OpenAPI 填 https://ark.cn-beijing.volces.com/api/v3；Agent Plan 企业版填 https://ark.cn-beijing.volces.com/api/plan/v3",
    models: "Seedance 视频模型可手输模型 ID，例如 doubao-seedance-2-5-260628；也可用 ep- 开头的推理接入点 ID。",
};

// 灵智（lk888.ai）按秒计费通道提示。
// 灵智是火山方舟 Ark 的一种方言：任务接口与请求体结构完全同 Ark，
// 差异在 model 必须用火山真名、duration 不接受 -1、不支持 asset:// 素材引用等。
export const anmiaoChannelTips = {
    baseUrl: "填 https://api.lk888.ai/api/v3/anmiao（备用线路 https://api.lingkeai.ai/api/v3/anmiao）。/anmiao 前缀必须保留，不要填成文档站域名 lk666.ai。",
    models: "灵智对外暴露的是计费 SKU（如 seedance-2.5-guanfang-anmiao），但请求体的 model 必须是火山真名 doubao-seedance-2-5-260628，两边对不上会被上游拒绝。",
    modelAliases: "必填：把灵智的计费 SKU 映射成火山真名，例如 seedance-2.5-guanfang-anmiao = doubao-seedance-2-5-260628。每行一条「前端模型名 = 上游模型名」。不配的话后台测试仍会显示通过（它不发真实视频请求），但实际生成会返回 400。",
    limits: "该通道按秒计费：duration 必须是 4~30 的整数秒（不支持 -1 智能时长）；不支持火山素材库 asset:// 引用；seed / watermark / generate_audio 等参数收下但不生效（视频恒有声、无水印）；产物地址本身是永久的，无需转存。",
};

// Flatkey 通道提示：视频走它自己的任务协议 /v1/generation/tasks，请求体与火山方舟同构。
export const flatkeyChannelTips = {
    baseUrl: "填 https://router.flatkey.ai/v1（只填到 /v1，不要带 /generation/tasks）",
    models: "视频模型手输即可，例如 seedance-2.5；模型列表可点「拉取全部渠道」读取 /v1/models。",
};

// A6API（a6api.vip）聚合网关提示。
// 它是标准 OpenAI 兼容形态：文本 /v1/chat/completions、图片 /v1/images/generations、
// 视频 /v1/videos + /v1/videos/{id} 轮询，路径与默认 openai 协议一致，不需要改写。
// 需要单独建协议只是为了不被「模型名含 seedance 就走火山」的兜底逻辑抢走。
export const a6apiChannelTips = {
    baseUrl: "填 https://api.a6api.vip 即可（不要带 /v1/chat/completions 这类完整路径）。站点域名 a6api.vip 是前端页面，网关是 api.a6api.vip。",
    models: "模型名以「模型市场」或 GET /v1/models 返回的 id 为准，支持别名映射。注意：该平台文档里举例的 sora-2、dall-e 系列、imagen 系列当前并未挂牌，照抄文档示例会直接失败。",
    modelAliases: "一般不用填：A6API 对外的模型 id 就是上游真名。只有用自定义展示名时才映射，例如 my-image-pro = gpt-image-2.5，每行一条「前端模型名 = 上游模型名」。",
    limits: "图片为同步请求，size 必须用半角 x（1024x1024），全角 × 会报错；视频为异步任务，提交后用 /v1/videos/{id} 轮询，完成后经 /v1/videos/{id}/content 取片。视频时长按模型上限收敛（如 veo-3.1 固定 8 秒、kling-2.6 最多 10 秒）。",
};

// A6API 的模型能力不一定能从名字看出来（kling-3.0、veo-3.1、viduq3、sora-2 都不带 video 字样），
// 在后台渠道抽屉的「模型类型」里显式声明最稳。
export const a6apiModelCapabilityHint = "A6API 的 kling / veo / viduq3 / sora / happyhorse 系列按名字猜不出视频类型，请在「模型类型」里手动选成「视频」。";

// 判断 Base URL 是否指向 A6API 网关。前端在没拿到 protocol（旧配置）时用它兜底。
export function isA6APIBaseUrl(baseUrl: string) {
    try {
        const host = new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
        return host === "a6api.vip" || host.endsWith(".a6api.vip");
    } catch {
        return false;
    }
}

// WaveSpeedAI 深度视频通道提示。
// 跑的是真实的单目深度估计（Video Depth Anything），不是让视频模型「照着提示词画深度图」。
export const wavespeedChannelTips = {
    baseUrl: "填 https://api.wavespeed.ai（后端会自动补 /api/v3）。注意 api.wavespeed.ai 才是接口域名，wavespeed.ai 是官网页面。",
    models: "深度视频模型填 wavespeed-ai/depth-anything/video；需要可选配色（灰度/伪彩）时用 wavespeed-ai/depth-anything-v3/video。",
    modelAliases: "可选：想用简短展示名时做映射，例如 depth-video = wavespeed-ai/depth-anything/video，每行一条「前端模型名 = 上游模型名」。",
    limits: "按输入视频秒数计费（$0.005/秒，最低 3 秒、最长 600 秒）。video 必须是公网可访问的 URL，不支持本地文件直传；产物保留输入分辨率与音轨。",
};

// Hugging Face Gradio Space 深度视频通道提示。
// 官方 Video-Depth-Anything 演示跑在 ZeroGPU 上，未登录无法触发 GPU 计算。
export const huggingfaceChannelTips = {
    baseUrl: "填 https://depth-anything-video-depth-anything.hf.space（官方 Space 直连域名）。直接粘 huggingface.co/spaces/... 页面地址也能自动换算成直连域名。",
    apiKey: "这里填 Hugging Face 的 Access Token（hf_ 开头，Read 权限足够）。ZeroGPU 强制要求登录状态，不填必定失败。",
    models: "深度视频模型填 video-depth-anything；实际调用的是 Space 的 infer_video_depth 端点，参数顺序固定为 video / max_len / target_fps / max_res / grayscale。",
    limits: "免费账号每天 5 分钟 GPU、单次最长 240 秒，长视频会排队甚至超时。建议 max_res 用 518（与模型 input_size 一致），必要时降 target_fps；产物由后端转存到本地，Space 重启不会丢。",
};

// 判断 Base URL 是否指向 WaveSpeedAI。
export function isWaveSpeedBaseUrl(baseUrl: string) {
    try {
        const host = new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
        return host === "api.wavespeed.ai" || host.endsWith(".wavespeed.ai");
    } catch {
        return false;
    }
}

// 判断 Base URL 是否指向 Hugging Face Space。
export function isHuggingFaceBaseUrl(baseUrl: string) {
    try {
        const host = new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
        return host === "hf.space" || host.endsWith(".hf.space") || host === "huggingface.co" || host.endsWith(".huggingface.co");
    } catch {
        return false;
    }
}

// 深度视频模型名判定。两个渠道的默认模型：
//   WaveSpeed    wavespeed-ai/depth-anything/video（以及 -v3 变体）
//   HuggingFace  video-depth-anything
// 深度视频是「从已有视频估计几何」而不是「生成」，参数与普通视频模型完全不同，
// 所以判定必须独立于「名字里有没有 video」。
export function isDepthVideoModelName(modelName: string) {
    const name = String(modelName || "").trim().toLowerCase();
    if (!name) {
        return false;
    }
    return name.includes("depth-anything") || name.includes("depth_anything") || name.includes("video-depth") || name.includes("depth-video");
}

// 深度视频的两个渠道与默认模型，供渠道表单与画布侧共用。
export const depthVideoChannelDefaults = {
    wavespeed: { protocol: "wavespeed" as const, model: "wavespeed-ai/depth-anything/video", label: "WaveSpeedAI" },
    huggingface: { protocol: "huggingface" as const, model: "video-depth-anything", label: "HuggingFace Space" },
};
