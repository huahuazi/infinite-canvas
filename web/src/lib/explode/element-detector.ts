"use client";

// 元素爆炸 —— AI 自动元素定位（方案 B）
// 用多模态文本模型读取图片，输出结构化 JSON 元素清单：[{name, bbox}]
// 复用现有 canvas-agent 多模态链路（requestCanvasAgentTurn），失败降级返回空数组，
// 由 UI 层引导用户走手动框选（方案 C 兜底）。
// 注意：bbox 为原图归一化坐标（0~1），定位不重画，只做识别。

import { requestCanvasAgentTurn } from "@/services/api/canvas-agent";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { MattingRect } from "./segment-matting";

export type DetectedElement = {
    name: string;
    bbox: MattingRect; // 原图像素坐标
    occluded?: boolean; // 标注是否疑似被遮挡（缺口）
};

export type DetectOptions = {
    config: AiConfig;
    onProgress?: (message: string) => void;
};

const DETECT_SYSTEM_PROMPT = [
    "你是专业图像元素识别助手。",
    "给定一张图片，识别其中所有可独立拆分的物体/元素，并按重要性排序。",
    "只输出一个 JSON 对象，不要任何其他文字或 markdown 代码块。",
    '格式：{"elements":[{"name":"元素名","bbox":[x,y,w,h]}]}',
    "要求：",
    "- name 用简短中文名词（如：手提包、人物、眼镜、茶杯）",
    "- bbox 是 [x, y, width, height]，取值 0~1 的归一化矩形（相对整图）",
    "- 尽量识别所有清晰的独立物体，至少 1 个，最多 15 个",
    "- 只输出 JSON，不解释",
].join("\n");

export type DetectResult = {
    elements: DetectedElement[];
    error?: string;
};

export async function detectElements(source: string | Blob, options: DetectOptions): Promise<DetectResult> {
    try {
        const dataUrl = await imageToDataUrl({ dataUrl: toSourceUrl(source), url: typeof source === "string" ? toSourceUrl(source) : undefined });
        if (!dataUrl) return { elements: [], error: "未能读取图片内容" };
        const config: AiConfig = { ...options.config, model: options.config.textModel || options.config.model };
        const turn = await requestCanvasAgentTurn({
            config,
            systemPrompt: DETECT_SYSTEM_PROMPT,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "识别这张图片里的元素，输出 JSON。" },
                        { type: "image_url", image_url: { url: dataUrl } },
                    ],
                },
            ],
            tools: [],
            allowTools: false,
        });
        const elements = parseElementsJson(turn.content);
        if (!elements.length) return { elements, error: "模型未返回可识别元素，可尝试手动框选" };
        return { elements };
    } catch (error) {
        console.warn("[element-detector] AI 定位失败，将引导手动框选", error);
        const message = error instanceof Error ? error.message : "元素识别失败";
        return { elements: [], error: message };
    }
}

// 解析模型返回的 JSON，容错处理 markdown 代码块包裹、多余文字等
export function parseElementsJson(content: string): DetectedElement[] {
    const json = extractJson(content);
    if (!json) return [];
    try {
        const parsed = JSON.parse(json) as { elements?: Array<{ name?: string; bbox?: number[] }> };
        if (!Array.isArray(parsed.elements)) return [];
        return parsed.elements.map((item) => normalizedElement(item.name, item.bbox)).filter((item): item is DetectedElement => Boolean(item));
    } catch {
        return [];
    }
}

function normalizedElement(name: string | undefined, bbox: number[] | undefined): DetectedElement | null {
    if (!Array.isArray(bbox) || bbox.length < 4 || bbox.some((v) => !Number.isFinite(v))) return null;
    const [x, y, w, h] = bbox.map((v) => Number(v));
    const margin = 0.05;
    const minX = clamp01(x - margin);
    const minY = clamp01(y - margin);
    const maxX = clamp01(x + w + margin);
    const maxY = clamp01(y + h + margin);
    return {
        name: (name || "元素").trim(),
        bbox: { x: minX, y: minY, width: Math.max(0.02, maxX - minX), height: Math.max(0.02, maxY - minY) },
    };
}

function extractJson(content: string): string | null {
    if (!content) return null;
    const trimmed = content.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

    // 尝试提取 ```json ... ``` 块
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock?.[1]) return codeBlock[1].trim();

    // 再尝试找第一个 { 到最后一个 }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

    return null;
}

function toSourceUrl(source: string | Blob): string {
    if (typeof source === "string") return source;
    return URL.createObjectURL(source);
}

function clamp01(value: number) {
    return Math.min(1, Math.max(0, value));
}
