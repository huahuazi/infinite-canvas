export type ModelChannelProtocol = "openai" | "gemini" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "ark" | "flatkey";

export const modelChannelDefaultBaseUrls: Record<ModelChannelProtocol, string> = {
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
    grok2api: "",
    metaso: "https://metaso.cn/api/minimax",
    apimart: "https://api.apimart.ai/v1",
    kie: "https://api.kie.ai/api/v1",
    mimo: "https://api.xiaomimimo.com",
    ark: "https://ark.cn-beijing.volces.com/api/v3",
    flatkey: "https://router.flatkey.ai/v1",
};

export const modelChannelApiKeyUrls: Partial<Record<ModelChannelProtocol, string>> = {
    metaso: "https://metaso.cn/minimax-h3/?s=tt",
    apimart: "https://apimart.ai/register?aff=fWMrEv",
    mimo: "https://platform.xiaomimimo.com/?ref=JFZQR2",
    ark: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
};

// 火山方舟通道的提示信息，供后台渠道表单展示。
export const arkChannelTips = {
    baseUrl: "官方 OpenAPI 填 https://ark.cn-beijing.volces.com/api/v3；Agent Plan 企业版填 https://ark.cn-beijing.volces.com/api/plan/v3；灵智按秒计费填 https://api.lk888.ai/api/v3/anmiao（/anmiao 必须保留，不要裁掉）",
    models: "Seedance 视频模型可手输模型 ID，例如 doubao-seedance-2-5-260628；也可用 ep- 开头的推理接入点 ID。若渠道的 /models 返回的是平台自己的 SKU（如灵智的 seedance-2.5-guanfang-anmiao），需要在下方「模型名映射」里配一条 SKU → doubao-* 真名，否则请求会被上游拒绝。",
};

// 灵智按秒计费通道的额外说明（Base URL 命中 /anmiao 时展示）。
export const anmiaoChannelTips = {
    modelAliases: "必填：把灵智的计费 SKU 映射成火山真名，例如 seedance-2.5-guanfang-anmiao → doubao-seedance-2-5-260628。每行一条「前端模型名 = 上游模型名」。不配的话后台测试仍会显示通过（它不发真实视频请求），但实际生成会返回 400。",
    limits: "该通道按秒计费：duration 必须是 4~30 的整数秒（不支持 -1 智能时长）；不支持火山素材库 asset:// 引用；seed / watermark / generate_audio 等参数收下但不生效（视频恒有声、无水印）；产物地址本身是永久的，无需转存。",
};

// Flatkey 通道提示：视频走它自己的任务协议 /v1/generation/tasks，请求体与火山方舟同构。
export const flatkeyChannelTips = {
    baseUrl: "填 https://router.flatkey.ai/v1（只填到 /v1，不要带 /generation/tasks）",
    models: "视频模型手输即可，例如 seedance-2.5；模型列表可点「拉取全部渠道」读取 /v1/models。",
};
