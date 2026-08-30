"use client";

// 元素爆炸 —— 主流程编排（方案 3：RMBG 抠图为主 + image-2 只补缺口）
// 1) 对每个元素 bbox 用本地 RMBG 像素级抠透明底
// 2) 检测该元素是否被遮挡（缺口）
// 3) 仅对被遮挡元素调用 image-2 补全
// 4) 全部 uploadImage，生成独立透明 PNG 子节点数据，按原图右侧排布

import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { fitNodeSize } from "@/app/(user)/canvas/utils/canvas-node-size";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeType } from "@/app/(user)/canvas/types";
import { mattingDataUrl, type MattingRect } from "@/lib/explode/segment-matting";
import { detectOccluded, inpaintElement, type DetectedElement } from "@/lib/explode/segment-inpaint";

export type ExplodeElementOption = {
    name: string;
    bbox: MattingRect;
    occludedToInpaint?: boolean; // 用户是否勾选"补全缺口"
};

export type ExplodeRequest = {
    source: string | Blob; // 原图 dataUrl/blob
    title: string;
    elements: ExplodeElementOption[];
    config: AiConfig;
    sourceId: string;
    naturalWidth: number;
    naturalHeight: number;
    // 原图节点在画布上的位置与尺寸（用于排布子节点）
    origin: { x: number; y: number; width: number; height: number };
    keepOriginal: boolean; // 是否保留原图节点
    onProgress?: (message: string) => void;
    onElementDone?: (index: number, element: ExplodeElementOption, result: { dataUrl: string; occluded: boolean }) => void;
};

export type ExplodeResult = {
    childNodes: CanvasNodeData[];
    usedInpaint: boolean; // 是否触发了 image-2 补全
    occludedCount: number;
};

export async function explodeImageNode(request: ExplodeRequest): Promise<ExplodeResult> {
    const { source, elements, config, sourceId, origin, onProgress, onElementDone } = request;
    const childNodes: CanvasNodeData[] = [];
    let usedInpaint = false;
    let occludedCount = 0;

    for (let i = 0; i < elements.length; i += 1) {
        const element = elements[i];
        onProgress?.(`正在抠图 ${i + 1}/${elements.length}：${element.name}`);

        // 1) 本地 RMBG 像素级抠图（保真）
        const dataUrl = await mattingDataUrl(source, { rect: toPixelRect(element.bbox, request.naturalWidth, request.naturalHeight) });

        // 2) 检测缺口（该元素是否被遮挡）
        const occluded = await detectOcclusionFromSource(dataUrl);

        // 3) 若用户勾选补全且确被遮挡 → image-2 补全
        let finalDataUrl = dataUrl;
        if (occluded && element.occludedToInpaint) {
            onProgress?.(`检测到「${element.name}」被遮挡，正在 AI 补全…`);
            usedInpaint = true;
            occludedCount += 1;
            try {
                const inpainted = await inpaintElement(dataUrl, { name: element.name, bbox: toPixelRect(element.bbox, request.naturalWidth, request.naturalHeight), occluded }, { config, sourceId });
                if (inpainted.dataUrl) {
                    finalDataUrl = inpainted.dataUrl;
                }
            } catch (error) {
                console.warn(`[canvas-explode] 补全「${element.name}」失败，保留 RMBG 结果`, error);
            }
        }

        // 4) 上传 + 生成子节点
        const uploaded = await uploadImageDataUrl(finalDataUrl);
        const size = fitNodeSize(uploaded.width, uploaded.height);
        const gapX = 96;
        const childX = origin.x + origin.width + gapX;
        const childY = origin.y + i * (size.height + 32);

        childNodes.push({
            id: createChildId(),
            type: "image" as CanvasNodeType,
            title: `${element.name}.png`,
            position: { x: childX, y: childY },
            width: size.width,
            height: size.height,
            metadata: {
                content: uploaded.url,
                storageKey: uploaded.storageKey,
                status: "success",
                naturalWidth: uploaded.width,
                naturalHeight: uploaded.height,
                bytes: uploaded.bytes,
                mimeType: uploaded.mimeType || "image/png",
            },
        });

        onElementDone?.(i, element, { dataUrl: finalDataUrl, occluded });
    }

    return { childNodes, usedInpaint, occludedCount };
}

// 检测某透明 PNG 是否有"缺口"（被遮挡）：提取 alpha 通道交给 detectOccluded 启发式
async function detectOcclusionFromSource(dataUrl: string): Promise<boolean> {
    try {
        const image = await loadImage(dataUrl);
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = detectOccluded(data.data, canvas.width, canvas.height);
        return result.occluded;
    } catch {
        return false;
    }
}

function toPixelRect(bbox: MattingRect, width: number, height: number): MattingRect {
    return {
        x: Math.max(0, Math.min(width, bbox.x)),
        y: Math.max(0, Math.min(height, bbox.y)),
        width: Math.max(1, Math.min(width - bbox.x, bbox.width)),
        height: Math.max(1, Math.min(height - bbox.y, bbox.height)),
    };
}

async function uploadImageDataUrl(dataUrl: string): Promise<UploadedImage> {
    return uploadImage(dataUrl, { localOnly: true });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
    });
}

function createChildId() {
    return `explode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
