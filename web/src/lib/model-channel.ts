export type ModelChannelProtocol = "openai" | "gemini" | "grok2api" | "metaso" | "apimart" | "kie" | "mimo" | "ark";

export const modelChannelDefaultBaseUrls: Record<ModelChannelProtocol, string> = {
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
    grok2api: "",
    metaso: "https://metaso.cn/api/minimax",
    apimart: "https://api.apimart.ai/v1",
    kie: "https://api.kie.ai/api/v1",
    mimo: "https://api.xiaomimimo.com",
    ark: "https://ark.cn-beijing.volces.com/api/v3",
};

export const modelChannelApiKeyUrls: Partial<Record<ModelChannelProtocol, string>> = {
    metaso: "https://metaso.cn/minimax-h3/?s=tt",
    apimart: "https://apimart.ai/register?aff=fWMrEv",
    mimo: "https://platform.xiaomimimo.com/?ref=JFZQR2",
    ark: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
};

// 火山方舟通道的提示信息，供后台渠道表单展示。
export const arkChannelTips = {
    baseUrl: "官方 OpenAPI 填 https://ark.cn-beijing.volces.com/api/v3；Agent Plan 企业版填 https://ark.cn-beijing.volces.com/api/plan/v3",
    models: "Seedance 视频模型可手输模型 ID，例如 doubao-seedance-2-5-260628；也可用 ep- 开头的推理接入点 ID。",
};
