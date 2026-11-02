import { modelKey } from "@/lib/video-model-capabilities";

// A6API 各视频模型的时长上限并不一致（veo-3.1 固定 8 秒、kling-2.6 最多 10 秒、
// sora-2 最多 12 秒…），超限时上游直接回 video_duration_invalid。
//
// 这张表被两处共用：
//   - services/api/video.ts 构造请求体时收敛
//   - components/video-settings-panel.tsx 限制输入框上限并给出提示
// 放在一起是为了避免「UI 显示能选 30 秒、实际只发 10 秒」这种静默不一致。
export type A6APIVideoDurationRule = { max: number; fixed?: number; auto: boolean };

export function a6apiVideoDurationRule(model: string): A6APIVideoDurationRule {
    const key = modelKey(model);
    if (key.includes("veo-3-1")) return { max: 8, fixed: 8, auto: false };
    if (key.includes("kling-2-6")) return { max: 10, auto: false };
    if (key.includes("kling-3") || key.includes("kling-4")) return { max: 15, auto: false };
    if (key.includes("viduq3")) return { max: 16, auto: false };
    if (key.includes("sora-2")) return { max: 12, auto: false };
    if (key.includes("grok-imagine-video")) return { max: 15, auto: false };
    if (key.includes("minimax-h3") || key.includes("happyhorse")) return { max: 15, auto: false };
    if (key.includes("seedance-2-5")) return { max: 30, auto: true };
    if (key.includes("seedance")) return { max: 15, auto: true };
    if (key.includes("wan3")) return { max: 30, auto: true };
    // 表外模型：接入文档标注默认 4 秒、保护上限 60 秒。
    return { max: 60, auto: true };
}

/** 输入框允许的上限：固定时长的模型（如 veo-3.1）直接锁死。 */
export function a6apiVideoDurationMax(model: string) {
    const rule = a6apiVideoDurationRule(model);
    return rule.fixed ?? rule.max;
}

/** 该模型是否支持 -1 / auto 智能时长。 */
export function a6apiVideoSupportsAutoDuration(model: string) {
    return a6apiVideoDurationRule(model).auto;
}

export function normalizeA6APIVideoSeconds(model: string, value: string): number {
    const rule = a6apiVideoDurationRule(model);
    if (rule.fixed) return rule.fixed;
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "-1" || raw === "auto") return rule.auto ? -1 : 5;
    const seconds = Math.floor(Number(raw) || 5);
    return Math.max(1, Math.min(rule.max, seconds));
}
