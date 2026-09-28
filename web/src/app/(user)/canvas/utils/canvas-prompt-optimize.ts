"use client";

// 提示词优化 —— 调文字大模型把画布上的草稿改写成可直接提交的高质量提示词，
// 并自动引用已连接的参考素材（写成 @图片1 / @视频1 这类芯片写法）。
//
// 设计要点：
// 1) 只走「文字模型」（config.textModel / config.textChannelId），不占用当前节点的生图 / 生视频模型；
// 2) 参考图会压缩成缩略图（最长边 512、WebP）随消息一起发给文字模型，让它真的"看得见"参考图；
//    若该文字模型不支持图片输入（部分渠道直接 400），自动降级为纯文本重试一次；
// 3) 输出必须原样使用 `@图片1` 这类编号写法，画布输入框（parsePromptTokens）会把标签渲染成芯片。

import { createImageThumbnail } from "@/lib/image-thumbnail";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { requestImageQuestion, type ChatCompletionMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasResourceReference } from "./canvas-resource-references";

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 1_500_000;

export type PromptOptimizeMode = "image" | "video" | "audio" | "text";

export type PromptOptimizeSettings = {
    model?: string;
    size?: string;
    seconds?: string;
    count?: string;
    quality?: string;
};

export type PromptOptimizeRequest = {
    mode: PromptOptimizeMode;
    prompt: string;
    references: CanvasResourceReference[];
    /** 文字模型配置（不要传当前节点的生图 / 生视频配置） */
    config: AiConfig;
    settings?: PromptOptimizeSettings;
};

export type PromptOptimizeResult = {
    prompt: string;
    /** 实际随消息发给模型的参考图数量 */
    usedImages: number;
};

const MODE_LABEL: Record<PromptOptimizeMode, string> = {
    image: "图片生成",
    video: "视频生成",
    audio: "音频生成",
    text: "文本生成",
};

const MODE_REQUIREMENTS: Record<PromptOptimizeMode, string[]> = {
    image: [
        "覆盖画面主体与外观细节（材质、颜色、款式、纹理）",
        "覆盖动作或状态、环境与背景",
        "覆盖构图与镜头（景别、角度、视点）、光线与色彩基调",
        "覆盖风格与质感（写实 / 摄影 / 插画 / 3D 等）以及画面清晰度",
    ],
    video: [
        "覆盖镜头运动（推拉摇移、跟随、环绕、固定机位等）与景别变化",
        "覆盖主体动作及其节奏、时间推进与画面内的前后变化",
        "覆盖环境氛围、光线变化与整体影调",
        "明确画面风格统一，必要时给出时长内的分镜节奏",
    ],
    audio: [
        "覆盖音色、语气、情绪与语速节奏",
        "覆盖使用场景与听感要求（清晰度、背景噪声、风格）",
    ],
    text: [
        "覆盖写作目的、受众、语气与文体",
        "覆盖结构要求、必须包含的要点与字数范围",
    ],
};

/** 把画布上的参考素材整理成给模型看的清单，并把图片压成缩略图。 */
async function collectReferenceContext(references: CanvasResourceReference[]) {
    const active = references.filter((reference) => reference.active);
    const lines: string[] = [];
    const images: string[] = [];

    for (const reference of active) {
        const title = (reference.title || "").trim();
        const kindLabel = reference.kind === "image" ? "图片素材" : reference.kind === "video" ? "视频素材" : reference.kind === "audio" ? "音频素材" : "文本素材";
        const excerpt = reference.kind === "text" ? (reference.text || "").trim().replace(/\s+/g, " ").slice(0, 120) : "";
        lines.push(`- @${reference.label}：《${title || reference.label}》${kindLabel}${excerpt ? `，内容摘要：${excerpt}` : ""}`);
        if (reference.kind === "image" && reference.previewUrl && images.length < MAX_REFERENCE_IMAGES) {
            const dataUrl = await toCompactImageDataUrl(reference.previewUrl);
            if (dataUrl) images.push(dataUrl);
        }
    }

    return { lines, images };
}

async function toCompactImageDataUrl(url: string): Promise<string | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) return null;
        const thumbnail = await createImageThumbnail(blob);
        const compact = thumbnail || blob;
        if (compact.size > MAX_REFERENCE_IMAGE_BYTES) return null;
        return await blobToDataUrl(compact);
    } catch {
        return null;
    }
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取参考图失败"));
        reader.readAsDataURL(blob);
    });
}

function buildInstruction(mode: PromptOptimizeMode, prompt: string, referenceLines: string[], imageCount: number, settings: PromptOptimizeSettings) {
    const draft = prompt.trim();
    const parameterLines = [
        settings.model ? `生成模型：${settings.model}` : "",
        settings.size ? `画面尺寸：${settings.size}` : "",
        settings.seconds ? `视频时长：${settings.seconds} 秒` : "",
        settings.count ? `生成数量：${settings.count}` : "",
        settings.quality ? `画质档位：${settings.quality}` : "",
    ].filter(Boolean);

    const sections: string[] = [
        `你是资深的 AI 生成提示词工程师。请把下面的草稿改写成一条可以直接提交给「${MODE_LABEL[mode]}」模型的高质量提示词。`,
        "",
        "【可用参考素材】（只能引用下列编号，绝对不要编造不存在的编号）",
        referenceLines.length ? referenceLines.join("\n") : "（本节点当前没有连接任何参考素材）",
        imageCount
            ? `其中前 ${imageCount} 张图片素材已作为图片一起发给你，请先看清图里的主体、配色、构图与风格，再动笔。`
            : "本次没有图片素材随消息发送，请只依据素材名称与草稿来写。",
        "",
        "【改写要求】",
        ...MODE_REQUIREMENTS[mode].map((item, index) => `${index + 1}. ${item}`),
        `${MODE_REQUIREMENTS[mode].length + 1}. 用中文书写，语言具体、可视、可执行，不要空话套话，不要再出现"帮我""请生成"这类对模型说话的口吻。`,
        `${MODE_REQUIREMENTS[mode].length + 2}. 需要引用素材时，必须原样写出 \`@图片1\`、\`@视频1\`、\`@文本1\` 这种 @ + 编号的写法（编号必须与上面清单完全一致），不要写成"第一张图""左边的参考图""参考图1"。`,
        `${MODE_REQUIREMENTS[mode].length + 3}. 引用要落在真正需要的地方：哪张图作主体、哪张图作风格或背景、哪段文本作对白，都要写清楚，但不要为了凑数硬引用。`,
        `${MODE_REQUIREMENTS[mode].length + 4}. 保留草稿里的专有名词、品牌词、人名地名与硬性约束（负面约束、禁忌项），不要擅自删改用户明确要求的内容。`,
        `${MODE_REQUIREMENTS[mode].length + 5}. 只输出提示词正文：不要解释、不要前言后语、不要标题、不要编号清单、不要 Markdown 代码块，也不要用引号把整段包起来。`,
        draft && referenceLines.length === 0 ? `${MODE_REQUIREMENTS[mode].length + 6}. 不要新增与草稿无关的元素，长度控制在草稿的 2~4 倍以内。` : "",
        "",
        "【用户草稿】",
        draft || "（草稿为空：请依据可用参考素材，直接写出一条适合当前生成类型的提示词。）",
    ];

    return sections.filter((line) => line !== "").join("\n");
}

/** 清理模型常见的多余包装：代码块、标题、引号、列表符号。 */
function stripOptimizedPromptNoise(text: string) {
    let result = text.trim();
    const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(result);
    if (fence) result = fence[1].trim();
    result = result.replace(/^(优化后的?提示词|改写后的?提示词|提示词|Prompt)\s*[:：]\s*/i, "");
    result = result.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "");
    result = result.replace(/^\s*["“”']([\s\S]*)["“”']\s*$/, "$1");
    return result.trim();
}

/**
 * 调文字大模型优化提示词。
 * 失败时抛错（含上游真实错误信息），由调用方决定如何提示用户。
 */
export async function optimizeCanvasPrompt(request: PromptOptimizeRequest): Promise<PromptOptimizeResult> {
    const { mode, prompt, references, config, settings = {} } = request;
    const { lines, images } = await collectReferenceContext(references);
    const instruction = buildInstruction(mode, prompt, lines, images.length, settings);
    const textPart = { type: "text" as const, text: instruction };
    const visionMessage: ChatCompletionMessage = {
        role: "user",
        content: images.length ? [textPart, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : instruction,
    };
    // 优化任务由本模块的指令全权驱动，临时屏蔽用户配置的文本系统提示，避免人设串味。
    const optimizerConfig: AiConfig = { ...config, systemPrompt: "", systemPrompts: { ...config.systemPrompts, text: "" } };

    let answer: string;
    try {
        answer = await requestImageQuestion(optimizerConfig, [visionMessage], () => {});
    } catch (error) {
        if (!images.length) throw error;
        // 文字模型不支持图片输入时（多数渠道返回 400 / invalid content），退化为纯文本重试。
        answer = await requestImageQuestion(optimizerConfig, [{ role: "user", content: instruction }], () => {});
    }

    const optimized = stripOptimizedPromptNoise(answer);
    if (!optimized) throw new Error("文字模型没有返回内容，请检查文字模型渠道配置");
    return { prompt: optimized, usedImages: images.length };
}

/** 参考图是否过大（用于 UI 上给出"未随消息发送"的提示，不影响主流程）。 */
export function isReferenceImageTooLarge(dataUrl: string) {
    return getDataUrlByteSize(dataUrl) > MAX_REFERENCE_IMAGE_BYTES;
}

const NON_TEXT_MODEL_KEYWORDS = ["image", "vision-", "video", "seedance", "kling", "sora", "veo", "hailuo", "wan/", "tts", "speech", "audio", "whisper", "embed", "rerank", "upscale", "banana"];

function isTextLikeModel(model: string) {
    const value = model.toLowerCase();
    return !NON_TEXT_MODEL_KEYWORDS.some((keyword) => value.includes(keyword));
}

/**
 * 在当前渠道模式下，找出真正提供这个模型的渠道 id。
 * 找不到时返回空串 —— 后端会按模型自动挑渠道，比塞一个对不上的 id 更安全。
 */
function channelIdServingModel(config: AiConfig, model: string) {
    const channels = config.channelMode === "remote" ? config.publicChannels || [] : config.localChannels || [];
    return channels.find((channel) => (channel.models || []).includes(model))?.id || "";
}

/**
 * 挑一个「能用来优化提示词」的文字模型配置。
 *
 * 优先用生效配置里的文字模型；生效配置没有时（典型场景：登录后走远程模式，但后台
 * 一个渠道都没配，此时 availableModels 为空、textModel 也为空），退回用户本地渠道
 * 里第一个文字模型，否则按钮会直接不可用。两者都没有才返回 null。
 */
export function resolvePromptOptimizeConfig(effective: AiConfig, raw: AiConfig): AiConfig | null {
    const textModel = effective.textModel || effective.textModels?.[0] || "";
    if (textModel) {
        // 渠道必须跟着文字模型一起解析。只换 model 不换渠道的话，配置里残留的 textChannelId
        // （典型来源：切到云端渠道之前选的本地渠道 id）会被原样当成 X-Model-Channel-ID 发出去，
        // 后端按模型筛出的渠道里没有这个 id，直接报「指定模型渠道不可用」。
        const channelId = channelIdServingModel(effective, textModel);
        return { ...effective, model: textModel, textModel, textChannelId: channelId, activeChannelId: channelId || effective.activeChannelId };
    }

    const channels = raw.localChannels || [];
    for (const channel of channels) {
        const model = (channel.models || []).find((item) => isTextLikeModel(item));
        if (!model) continue;
        return {
            ...effective,
            channelMode: "local",
            model,
            textModel: model,
            textChannelId: channel.id,
            activeChannelId: channel.id,
            localChannels: channels,
            baseUrl: channel.baseUrl || effective.baseUrl,
            apiKey: channel.apiKey || effective.apiKey,
            models: Array.from(new Set(channels.flatMap((item) => item.models || []))),
        };
    }
    return null;
}
