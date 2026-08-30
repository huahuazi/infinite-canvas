"use client";

// 元素爆炸 —— AI 生图方案（替代本地 RMBG 抠图）
// 逻辑：
// 1) 对每个涂抹选区：合成该区域高亮标记图 → 生成 image-2 编辑任务（background=transparent）
// 2) 全部元素生成后：合成所有区域高亮标记图 → 生成背景补全任务（移除框选区域内容）
// 3) 返回任务清单，由页面层创建 loading 节点并提交任务；结果由全局轮询刷新到节点
//
// 注意：代理渠道（usesAccountProxy）下 createCanvasImageTask 是异步任务，
// 必须走"创建节点 + 提交任务 + 轮询"模式，不能同步等 image_url（会一直空）。

import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeType } from "@/app/(user)/canvas/types";
import type { CanvasImageTask } from "@/services/api/image";
import type { MattingRect } from "@/lib/explode/segment-matting";
import { buildMarkedReference } from "@/app/(user)/canvas/utils/canvas-rect-edit";

export type ExplodeElementOption = {
    name: string;
    bbox?: MattingRect; // 归一化 0~1 包围盒（有 mask 时由 mask 包围盒优先）
    maskCanvas?: HTMLCanvasElement; // 用户画笔涂抹的自由选区（与原图同尺寸像素）
    occludedToInpaint?: boolean; // 兼容字段（AI 方案下不再使用）
};

export type ExplodeRequest = {
    source: string | Blob; // 原图 dataUrl/blob
    title: string;
    elements: ExplodeElementOption[];
    config: AiConfig;
    sourceId: string;
    naturalWidth: number;
    naturalHeight: number;
    origin: { x: number; y: number; width: number; height: number };
    keepOriginal: boolean;
    onProgress?: (message: string) => void;
};

// 预生成的编辑任务（含参考图 dataUrl 与 prompt），页面层据此建节点+提交
export type PreparedExplodeTask = {
    kind: "element" | "background";
    elementIndex: number;
    name: string;
    prompt: string;
    referenceDataUrl: string;
    referenceName: string;
    config: AiConfig & { seedIndex?: number; seedCount?: number };
};

export type ExplodeResult = {
    prepared: PreparedExplodeTask[];
    // 兼容：全部走异步任务，无同步结果
    childNodes: CanvasNodeData[];
    usedInpaint: boolean;
    occludedCount: number;
    backgroundNode?: CanvasNodeData;
};

export async function explodeImageNodeAi(request: ExplodeRequest): Promise<ExplodeResult> {
    const { source, elements, config, naturalWidth, naturalHeight, onProgress } = request;
    const prepared: PreparedExplodeTask[] = [];

    // 编辑链路配置：透明 PNG 输出
    const editConfig: AiConfig & { seedIndex?: number; seedCount?: number } = {
        ...config,
        background: "transparent",
        responseFormatB64Json: "1",
    };

    // 1) 逐元素预生成编辑任务
    for (let i = 0; i < elements.length; i += 1) {
        const element = elements[i];
        onProgress?.(`正在准备元素 ${i + 1}/${elements.length}：${element.name}`);

        const name = element.name || `元素${i + 1}`;
        const markedReference = await buildMarkedReference(toDataUrl(source), [{ id: name, maskCanvas: element.maskCanvas, prompt: "" }], { width: naturalWidth, height: naturalHeight });

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

        prepared.push({
            kind: "element",
            elementIndex: i,
            name,
            prompt,
            referenceDataUrl: markedReference,
            referenceName: `${name}.png`,
            config: editConfig,
        });
    }

    // 2) 背景补全任务（全部框选区域一起）
    if (elements.length > 0) {
        onProgress?.("正在准备背景补全图（移除所有框选区域内容）…");
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

            prepared.push({
                kind: "background",
                elementIndex: -1,
                name: "背景补全",
                prompt: backgroundPrompt,
                referenceDataUrl: allMarked,
                referenceName: "背景补全.png",
                config: { ...config, background: "auto", responseFormatB64Json: "1" },
            });
        } catch (error) {
            console.warn("[explode-ai] 背景补全任务准备失败（不影响元素任务）", error);
        }
    }

    return { prepared, childNodes: [], usedInpaint: prepared.length > 0, occludedCount: 0 };
}

export const explodeImageNode = explodeImageNodeAi;

function toDataUrl(source: string | Blob): string {
    if (typeof source === "string") return source;
    return URL.createObjectURL(source);
}
