import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const SEEDANCE_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export const seedanceResolutionOptions = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
] as const;

export const seedanceRatioOptions = [
    { value: "16:9", label: "横屏" },
    { value: "9:16", label: "竖屏" },
    { value: "1:1", label: "方形" },
    { value: "4:3", label: "标准横屏" },
    { value: "3:4", label: "标准竖屏" },
    { value: "21:9", label: "宽银幕" },
    { value: "adaptive", label: "自适应" },
] as const;

export const seedanceDurationOptions = [-1, 4, 5, 6, 8, 10, 12, 15] as const;

// Seedance 2.5 支持 30 秒连贯直出，其余模型上限 15 秒。
export const seedance25DurationOptions = [-1, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30] as const;

export function isSeedance25Model(model: string) {
    const value = String(model || "").toLowerCase();
    return value.includes("seedance-2-5") || value.includes("seedance-2.5");
}

export function seedanceDurationOptionsFor(model: string) {
    return isSeedance25Model(model) ? seedance25DurationOptions : seedanceDurationOptions;
}

export function seedanceDurationMax(model: string) {
    return isSeedance25Model(model) ? 30 : 15;
}

const seedancePixels = {
    "480p": {
        "16:9": "864x496",
        "4:3": "752x560",
        "1:1": "640x640",
        "3:4": "560x752",
        "9:16": "496x864",
        "21:9": "992x432",
    },
    "720p": {
        "16:9": "1280x720",
        "4:3": "1112x834",
        "1:1": "960x960",
        "3:4": "834x1112",
        "9:16": "720x1280",
        "21:9": "1470x630",
    },
    "1080p": {
        "16:9": "1920x1080",
        "4:3": "1664x1248",
        "1:1": "1440x1440",
        "3:4": "1248x1664",
        "9:16": "1080x1920",
        "21:9": "2206x946",
    },
    "2k": {
        "16:9": "2560x1440",
        "4:3": "2224x1668",
        "1:1": "1920x1920",
        "3:4": "1668x2224",
        "9:16": "1440x2560",
        "21:9": "2940x1260",
    },
    "4k": {
        "16:9": "3840x2160",
        "4:3": "3328x2496",
        "1:1": "2880x2880",
        "3:4": "2496x3328",
        "9:16": "2160x3840",
        "21:9": "4412x1892",
    },
} as const;

export function isSeedanceVideoConfig(config: Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    return isSeedanceVideoModel(config.model || config.videoModel) || isArkBaseUrl(config.baseUrl);
}

export function isSeedanceVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("doubao-seedance");
}

export function isSeedanceFastOrMiniModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && (value.includes("fast") || value.includes("mini"));
}

export function isArkPlanBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("ark.cn-beijing.volces.com/api/plan/v3") || baseUrl.toLowerCase().includes("/api/plan/v3");
}

// 火山方舟官方开放接口（标准 Ark OpenAPI）Base URL 形如：
// https://ark.cn-beijing.volces.com/api/v3
export function isArkOpenApiBaseUrl(baseUrl: string) {
    return /\/api\/v3(?:\/|$)/i.test(String(baseUrl || "").trim());
}

// 只要命中火山方舟任一通道（OpenAPI、Agent Plan，或火山官方域名）都按 Ark 协议处理。
// 其他第三方中转站即便模型名里带 seedance，也保持原有 /videos 行为，避免破坏兼容。
export function isArkBaseUrl(baseUrl: string) {
    const value = String(baseUrl || "").trim();
    if (isArkPlanBaseUrl(value) || isArkOpenApiBaseUrl(value)) return true;
    return isArkHost(value);
}

export function isArkHost(baseUrl: string) {
    return /(^|\.)volces\.com$/i.test(hostnameOf(baseUrl));
}

// 视频生成任务路径（火山方舟 OpenAPI 与 Agent Plan 共用同一套任务接口）。
export const ARK_VIDEO_TASK_PATH = "/contents/generations/tasks";

// 归一化火山方舟 Base URL：裁掉用户误贴的完整任务路径，并为火山官方域名补齐 /api/v3。
export function normalizeArkBaseUrl(baseUrl: string) {
    let value = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    const taskIndex = value.toLowerCase().indexOf(ARK_VIDEO_TASK_PATH.toLowerCase());
    if (taskIndex >= 0) value = value.slice(0, taskIndex).replace(/\/+$/, "");
    if (isArkPlanBaseUrl(value) || isArkOpenApiBaseUrl(value)) return value;
    if (isArkHost(value)) return `${value}/api/v3`;
    return value;
}

// Flatkey（router.flatkey.ai）的视频接口：POST /v1/videos，轮询 GET /v1/videos/{id}。
// 请求体与火山方舟同构（content[] + ratio + duration），所以复用 Ark 的构造与解析，只固定接口路径。
// 注意：flatkey 文档里的 /v1/generation/tasks 只对部分「通道类型」开放，
// seedance 系列会返回 "this channel type is only available on /v1/videos and /v1/video/generations"。
export const FLATKEY_VIDEO_PATH = "/videos";

export function isFlatkeyHost(baseUrl: string) {
    return /(^|\.)flatkey\.ai$/i.test(hostnameOf(baseUrl));
}

export function isFlatkeyBaseUrl(baseUrl: string) {
    return isFlatkeyHost(baseUrl);
}

// 归一化 Flatkey Base URL：裁掉用户误贴的完整接口路径（/videos、/video/generations、/generation/tasks），
// 并为裸域名补齐 /v1，避免拼出 /v1/videos/videos。
export function normalizeFlatkeyBaseUrl(baseUrl: string) {
    let value = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    for (const suffix of ["/generation/tasks", "/video/generations", FLATKEY_VIDEO_PATH]) {
        const index = value.toLowerCase().indexOf(suffix.toLowerCase());
        if (index >= 0) {
            value = value.slice(0, index).replace(/\/+$/, "");
            break;
        }
    }
    if (/\/v\d+$/i.test(value)) return value;
    return `${value}/v1`;
}

export function hostnameOf(value: string) {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

export function normalizeSeedanceResolution(value: string, model = "") {
    const normalized = normalizeResolutionToken(value);
    if (isSeedanceFastOrMiniModel(model) && normalized === "1080p") return "720p";
    return seedanceResolutionOptions.some((item) => item.value === normalized) ? normalized : "720p";
}

export function normalizeResolutionToken(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = String(value || "").replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function normalizeSeedanceDuration(value: string, model = "") {
    if (String(value).trim() === "-1") return -1;
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(seedanceDurationMax(model), seconds));
}

export function normalizeSeedanceRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (seedanceRatioOptions.some((item) => item.value === value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

export function seedancePixelLabel(resolution: string, ratio: string) {
    const resolutionKey = resolution.trim().toLowerCase();
    const normalizedResolution = (resolutionKey in seedancePixels ? resolutionKey : normalizeSeedanceResolution(resolution)) as keyof typeof seedancePixels;
    const normalizedRatio = normalizeSeedanceRatio(ratio) as keyof (typeof seedancePixels)[typeof normalizedResolution] | "adaptive";
    if (normalizedRatio === "adaptive") return "自动匹配";
    return seedancePixels[normalizedResolution][normalizedRatio] || "";
}

export function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export function seedanceReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    if (kind === "image") return `图片${index + 1}`;
    if (kind === "video") return `视频${index + 1}`;
    return `音频${index + 1}`;
}

export function buildSeedancePromptText(prompt: string, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const labels = [
        ...images.map((_, index) => seedanceReferenceLabel("image", index)),
        ...videos.map((_, index) => seedanceReferenceLabel("video", index)),
        ...audios.map((_, index) => seedanceReferenceLabel("audio", index)),
    ];
    const text = prompt.trim();
    if (!labels.length) return text;
    return `参考素材编号：${labels.join("、")}。请按这些编号理解提示词中的图片、视频和音频引用。\n\n${text}`;
}

export function seedanceVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (video.bytes && video.bytes > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes) return `${label} 超过 50MB，请压缩后再上传`;
        if (video.durationMs) {
            if (video.durationMs < 2000 || video.durationMs > 15000) return `${label} 时长需要在 2-15 秒之间`;
            totalDurationMs += video.durationMs;
        }
        if (video.width && video.height) {
            if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000) return `${label} 宽高需要在 300-6000px 之间`;
            const ratio = video.width / video.height;
            if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需要在 0.4-2.5 之间`;
            const pixels = video.width * video.height;
            if (pixels < 640 * 640 || pixels > 2206 * 946) return `${label} 像素总量不符合 Seedance 要求，请转成 480p/720p/1080p 后再上传`;
        }
    }
    if (totalDurationMs > 15000) return "Seedance 参考视频总时长不能超过 15 秒";
    return "";
}

export const seedanceVideoReferenceHint = "参考视频需为 mp4/mov，H.264/H.265，FPS 24-60；含真人人脸素材请使用火山授权 asset:// 素材。";
