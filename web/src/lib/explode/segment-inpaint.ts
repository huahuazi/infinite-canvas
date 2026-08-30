"use client";

// 元素爆炸 —— 遮挡缺口检测 + image-2 补全（方案 3 的"补缺"环节）
// RMBG 像素级抠图会把被上层遮挡的元素抠成"缺一口"（原图那块是别的像素）。
// 本模块：1) 检测某元素 mask 是否被遮挡（缺口）；2) 对被遮挡的元素，
//        调用 image-2 编辑链路，prompt 要求"补全被遮挡部分、保留主体原样、透明底"。
//        复用项目现有 createCanvasImageTask（已支持 config.background="transparent"）。

import { createCanvasImageTask, type CanvasImageTask } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import type { MattingRect } from "./segment-matting";

export type DetectedElement = {
    name: string;
    bbox: MattingRect; // 原图坐标
    occluded?: boolean; // 是否被遮挡（有缺口）
};

export type InpaintOptions = {
    config: AiConfig; // 含背景透传
    sourceId: string;
    clientTaskIdPrefix?: string;
    onProgress?: (message: string) => void;
};

// ---- 缺口检测：从左/右/上/下四条边探测 mask 是否被切断 ----
// 原理：RMBG 输出 mask 若元素完整，四条边的关键采样点应大部分非透明；
// 若某条边大面积透明、但紧邻内部又是实体，说明该侧被遮挡。
// 这是启发式，只用于标记"可能被遮挡"，最终由用户确认是否要补全。
export function detectOccluded(maskAlpha: Uint8ClampedArray | number[], width: number, height: number, options: { threshold?: number; sampleStride?: number } = {}): { occluded: boolean; sides: Array<"left" | "right" | "top" | "bottom"> } {
    const threshold = options.threshold ?? 32; // alpha 低于该值视为"透明"
    const sampleStride = options.sampleStride ?? Math.max(1, Math.floor(Math.min(width, height) / 40));

    const sampleAlpha = (x: number, y: number) => {
        const idx = (y * width + x) * 4 + 3;
        return idx < maskAlpha.length ? maskAlpha[idx] : 0;
    };

    const touchesLeft = scanSide("left");
    const touchesRight = scanSide("right");
    const touchesTop = scanSide("top");
    const touchesBottom = scanSide("bottom");
    const sides: Array<"left" | "right" | "top" | "bottom"> = [];
    if (touchesLeft) sides.push("left");
    if (touchesRight) sides.push("right");
    if (touchesTop) sides.push("top");
    if (touchesBottom) sides.push("bottom");

    // 元素"撑满"某条边但内部应有主体 → 说明该侧可能被裁/被挡
    const occluded = sides.length >= 1 && !isSolidCore(maskAlpha, width, height, threshold);

    return { occluded, sides };

    function scanSide(side: "left" | "right" | "top" | "bottom"): boolean {
        let filled = 0;
        let total = 0;
        if (side === "left" || side === "right") {
            const x = side === "left" ? 0 : width - 1;
            for (let y = 0; y < height; y += sampleStride) {
                total += 1;
                if (sampleAlpha(x, y) > threshold) filled += 1;
            }
        } else {
            const y = side === "top" ? 0 : height - 1;
            for (let x = 0; x < width; x += sampleStride) {
                total += 1;
                if (sampleAlpha(x, y) > threshold) filled += 1;
            }
        }
        return total > 0 && filled / total > 0.55; // 该边大面积被主体占据
    }
}

// 判断元素主体是否"实心"——若四条边都贴边但中心稀薄，可能是被挡的空壳
function isSolidCore(maskAlpha: Uint8ClampedArray | number[], width: number, height: number, threshold: number): boolean {
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const r = Math.max(1, Math.floor(Math.min(width, height) * 0.3));
    let filled = 0;
    let total = 0;
    for (let y = cy - r; y <= cy + r; y += Math.max(1, Math.floor(r / 8))) {
        for (let x = cx - r; x <= cx + r; x += Math.max(1, Math.floor(r / 8))) {
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const idx = (y * width + x) * 4 + 3;
            total += 1;
            if (idx < maskAlpha.length && maskAlpha[idx] > threshold) filled += 1;
        }
    }
    return total > 0 && filled / total > 0.35;
}

// 用 image-2 编辑链路补全被遮挡的元素，输出透明底 PNG
export async function inpaintElement(source: string | Blob, element: DetectedElement, options: InpaintOptions): Promise<{ dataUrl: string; task?: CanvasImageTask }> {
    const prompt = [
        "这是一张被上层物体遮挡了部分的图片元素。",
        "请补全被遮挡的区域，使其成为一个完整、独立的物体。",
        "严格要求：",
        "- 保持主体原本的材质、颜色、光影、朝向和风格，不改变未遮挡部分",
        "- 只补全被遮挡的空缺部分，不要重画整个主体",
        "- 背景完全透明，不要生成任何背景、台面、阴影或环境",
        "- 输出带 alpha 通道的透明 PNG",
    ].join("\n");

    const config: AiConfig & { seedIndex?: number; seedCount?: number } = {
        ...options.config,
        background: "transparent",
        responseFormatB64Json: "1",
    };

    const task = await createCanvasImageTask(config, prompt, [{ id: element.name, name: `${element.name}.png`, type: "image/png", dataUrl: toDataUrl(source), storageKey: undefined }], {
        source: "canvas",
        sourceId: options.sourceId,
        clientTaskId: options.clientTaskIdPrefix ? `${options.clientTaskIdPrefix}_${Date.now()}` : undefined,
    });

    return { dataUrl: task.image_url || "", task };
}

function toDataUrl(source: string | Blob): string {
    if (typeof source === "string") return source;
    return URL.createObjectURL(source);
}
