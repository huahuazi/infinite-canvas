"use client";

// 元素爆炸 —— AI 生图方案（替代本地 RMBG 抠图）
// 逻辑：
// 1) 对每个涂抹选区：原图 + 该区域高亮标记图 → image-2（编辑链路，background=transparent）
//    生成"只含该元素、透明底、独立完整"的 PNG → 上传为画布子节点
// 2) 全部元素生成完后：原图 + 所有区域高亮标记图 → image-2 生成
//    "移除所有标记区域内的物体、用周围背景自然补全"的完整图 → 上传为背景补全子节点
// 3) 子节点按原图右侧排布连线
//
// 透明输出链路复用 inpaintElement 已验证的方式：
// config.background = "transparent" + responseFormatB64Json = "1"

import { uploadImage } from "@/services/image-storage";
import { fitNodeSize } from "@/app/(user)/canvas/utils/canvas-node-size";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeType } from "@/app/(user)/canvas/types";
import { createCanvasImageTask } from "@/services/api/image";
import type { MattingRect } from "@/lib/explode/segment-matting";
import { buildMarkedReference } from "@/app/(user)/canvas/utils/canvas-rect-edit";

export type ExplodeElementOption = {
    name: string;
    bbox?: MattingRect; // 归一化 0~1 包围盒（有 mask 时由 mask 包围盒优先）
    maskCanvas?: HTMLCanvasElement; // 用户画笔涂抹的自由选区（与原图同尺寸像素）
    occludedToInpaint?: boolean; // 保留兼容字段（AI 方案下不再使用）
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
    usedInpaint: boolean; // 兼容：AI 方案下 = 至少生成过一个元素
    occludedCount: number; // 兼容：AI 方案下无遮挡概念，恒 0
    backgroundNode?: CanvasNodeData; // 背景补全图节点（去掉框选区域内容）
};

export async function explodeImageNodeAi(request: ExplodeRequest): Promise<ExplodeResult> {
    return explodeImageNodeInternal(request);
}

// 兼容旧调用名
export const explodeImageNode = explodeImageNodeAi;

async function explodeImageNodeInternal(request: ExplodeRequest): Promise<ExplodeResult> {
    const { source, elements, config, sourceId, origin, naturalWidth, naturalHeight, onProgress, onElementDone } = request;
    const childNodes: CanvasNodeData[] = [];
    let usedInpaint = false;

    // 编辑链路配置：透明 PNG 输出
    const editConfig: AiConfig & { seedIndex?: number; seedCount?: number } = {
        ...config,
        background: "transparent",
        responseFormatB64Json: "1",
    };

    const gapX = 96;
    const gapY = 24;

    // 1) 逐元素生成透明底独立 PNG
    for (let i = 0; i < elements.length; i += 1) {
        const element = elements[i];
        onProgress?.(`正在生成元素 ${i + 1}/${elements.length}：${element.name}`);

        // 合成该元素的高亮标记图（原图 + 仅此区域 mask 高亮 + 大号编号）
        const markedReference = await buildMarkedReference(toDataUrl(source), [{ id: element.name || `元素${i + 1}`, maskCanvas: element.maskCanvas, prompt: "" }], { width: naturalWidth, height: naturalHeight });

        const prompt = [
            "参考图中被彩色高亮覆盖的区域是需要提取的元素。",
            "请将该区域内的物体完整、独立地提取出来，生成一张透明背景的 PNG。",
            "严格要求：",
            "- 只保留被高亮标记区域内的物体本身",
            "- 物体的材质、颜色、朝向、光影与参考图一致，保持完整不残缺",
            "- 背景完全透明，不要生成任何背景、台面、阴影或环境",
            "- 彩色高亮只是编辑标记，不要保留在最终图像中",
            "- 输出带 alpha 通道的透明 PNG",
        ].join("\n");

        const task = await createCanvasImageTask(editConfig, prompt, [{ id: `${request.title}-${element.name}-${i}`, name: `${element.name || `元素${i + 1}`}.png`, type: "image/png", dataUrl: markedReference, storageKey: undefined }], {
            source: "canvas",
            sourceId,
            clientTaskId: `explode_ai_${Date.now()}_${i}`,
        });

        const dataUrl = task.image_url || "";
        if (!dataUrl) {
            onProgress?.(`元素「${element.name}」未返回结果，跳过`);
            continue;
        }

        // 归一化并上传
        const uploaded = await uploadImage(dataUrl, { localOnly: true });
        const size = fitNodeSize(uploaded.width, uploaded.height);
        const childX = origin.x + origin.width + gapX;
        const childY = origin.y + i * (size.height + gapY);

        childNodes.push({
            id: createChildId(),
            type: "image" as CanvasNodeType,
            title: `${element.name || `元素${i + 1}`}.png`,
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

        usedInpaint = true;
        onElementDone?.(i, element, { dataUrl, occluded: false });
    }

    // 2) 生成背景补全图：去掉所有框选区域内容，用周围背景自然补全
    let backgroundNode: CanvasNodeData | undefined;
    if (elements.length > 0 && usedInpaint) {
        onProgress?.("正在生成背景补全图（移除所有框选区域内容）…");
        try {
            const allMarked = await buildMarkedReference(
                toDataUrl(source),
                elements.map((element, index) => ({ id: element.name || `元素${index}`, maskCanvas: element.maskCanvas, prompt: "" })),
                { width: naturalWidth, height: naturalHeight },
            );

            const backgroundPrompt = [
                "参考图中有多处被彩色高亮标记的区域。",
                "请把所有这些被标记区域内的物体从画面中移除，并用周围的环境内容自然补全被移除的位置。",
                "严格要求：",
                "- 只移除被彩色高亮标记区域内的物体，未标记区域保持原样",
                "- 被移除的位置用周围的背景、纹理、光影自然衔接，看起来像原本就不存在该物体",
                "- 保持整体构图、透视、光影和风格不变",
                "- 彩色高亮只是编辑标记，不要保留在最终图像中",
                "- 输出完整尺寸的图像，不要裁剪",
            ].join("\n");

            const backgroundConfig: AiConfig & { seedIndex?: number; seedCount?: number } = {
                ...config,
                background: "auto",
                responseFormatB64Json: "1",
            };

            const task = await createCanvasImageTask(backgroundConfig, backgroundPrompt, [{ id: `${request.title}-background`, name: "背景补全.png", type: "image/png", dataUrl: allMarked, storageKey: undefined }], {
                source: "canvas",
                sourceId,
                clientTaskId: `explode_ai_bg_${Date.now()}`,
            });

            const bgUrl = task.image_url || "";
            if (bgUrl) {
                const uploaded = await uploadImage(bgUrl, { localOnly: true });
                const size = fitNodeSize(uploaded.width, uploaded.height);
                backgroundNode = {
                    id: createChildId(),
                    type: "image" as CanvasNodeType,
                    title: "背景补全.png",
                    position: { x: origin.x + origin.width + gapX, y: origin.y + elements.length * (size.height + gapY) + gapY },
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
                };
            }
        } catch (error) {
            console.warn("[explode-ai] 背景补全生成失败（不影响元素 PNG）", error);
        }
    }

    return { childNodes, usedInpaint, occludedCount: 0, backgroundNode };
}

function toDataUrl(source: string | Blob): string {
    if (typeof source === "string") return source;
    return URL.createObjectURL(source);
}

function createChildId() {
    return `explode-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
