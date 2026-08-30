"use client";

// 框选修改 —— 主流程编排（画笔版）
// 用户用画笔涂抹多个区域，每个区域配文字描述，合成为一张「标记图」
// （每块涂抹选区按颜色高亮显示 + 编号角标），交给 image-2 编辑链路一次性修改全部区域。

import type { MattingRect } from "@/lib/explode/segment-matting";

export type RectEditItem = {
    id: string;
    maskCanvas?: HTMLCanvasElement; // 画笔涂抹选区（原图尺寸）
    bbox?: MattingRect; // 归一化包围盒（无 mask 时用）
    prompt: string;
};

export type RectEditMarkerOptions = {
    width: number;
    height: number;
    regionColors?: string[];
};

const DEFAULT_REGION_COLORS = ["#2f80ff", "#f58220", "#e24b4a", "#1d9e75", "#854f0b", "#993556", "#185fa5"];

// 合成标记图：原图打底 + 每个区域半透明高亮 + 编号 + 虚线描边
export function buildMarkedReference(source: string, items: RectEditItem[], options: RectEditMarkerOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = options.width;
            canvas.height = options.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return reject(new Error("读取标记图失败"));
            ctx.drawImage(image, 0, 0, options.width, options.height);

            items.forEach((item, index) => {
                const color = (options.regionColors || DEFAULT_REGION_COLORS)[index % (options.regionColors || DEFAULT_REGION_COLORS).length];
                const rect = item.maskCanvas ? maskBoundsRect(item.maskCanvas) : normalizeRect(item.bbox!, options.width, options.height);

                // 区域高亮：优先涂抹 mask 形状，否则矩形填充
                if (item.maskCanvas) {
                    ctx.save();
                    ctx.globalCompositeOperation = "source-over";
                    // 用 mask 作为 alpha 通道填充色块
                    const tint = document.createElement("canvas");
                    tint.width = options.width;
                    tint.height = options.height;
                    const tintCtx = tint.getContext("2d");
                    if (tintCtx) {
                        tintCtx.clearRect(0, 0, tint.width, tint.height);
                        tintCtx.drawImage(item.maskCanvas, 0, 0, options.width, options.height);
                        tintCtx.globalCompositeOperation = "source-in";
                        tintCtx.fillStyle = color;
                        tintCtx.fillRect(0, 0, tint.width, tint.height);
                        ctx.drawImage(tint, 0, 0);
                    }
                    ctx.restore();
                } else {
                    ctx.fillStyle = color + "33";
                    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
                }

                // 边缘描边（mask 用包围盒，矩形用本身）
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(2, Math.round(Math.min(options.width, options.height) / 300));
                ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 3]);
                ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                ctx.restore();

                // 编号角标
                const label = String(index + 1);
                ctx.save();
                ctx.font = `bold ${Math.max(22, Math.round(Math.min(options.width, options.height) / 22))}px sans-serif`;
                const metrics = ctx.measureText(label);
                const pad = 8;
                const bx = rect.x;
                const by = rect.y;
                ctx.fillStyle = color;
                ctx.fillRect(bx, by, metrics.width + pad * 2, Math.round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) + pad * 2);
                ctx.fillStyle = "#fff";
                ctx.textBaseline = "top";
                ctx.textAlign = "left";
                ctx.fillText(label, bx + pad, by + pad);
                ctx.restore();
            });

            resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => reject(new Error("读取原图失败"));
        const src = source.startsWith("data:") || source.startsWith("blob:") ? source : source;
        image.src = src;
    });
}

// 组装多区域修改 prompt
export function buildRectEditPrompt(items: RectEditItem[]): string {
    const regionLines = items
        .slice()
        .sort((a, b) => orderIndex(a.id, items) - orderIndex(b.id, items))
        .map((item, index) => {
            const label = index + 1;
            const prompt = item.prompt.trim();
            return `标记区域 ${label}：${prompt}`;
        });

    const lines = [
        "这是一张带有多个标记区域的图片，每个区域用不同颜色和编号标注。",
        "请严格按编号逐一修改对应标记区域：",
        ...regionLines,
        "要求：",
        "- 只修改被标记的区域，区域之外保持原样，不改变整体构图、人物、光影和风格",
        "- 编号和彩色框只是编辑标记，不要保留在最终图像中",
        "- 修改内容与实际被标记的物体保持一致",
    ];
    return lines.join("\n");
}

function orderIndex(id: string, items: RectEditItem[]): number {
    const i = items.findIndex((item) => item.id === id);
    return i < 0 ? 0 : i;
}

function normalizeRect(bbox: MattingRect, width: number, height: number): MattingRect {
    const x = clamp(bbox.x, 0, 1) * width;
    const y = clamp(bbox.y, 0, 1) * height;
    const w = clamp(bbox.width, 0.02, 1) * width;
    const h = clamp(bbox.height, 0.02, 1) * height;
    return { x, y, width: Math.min(w, width - x), height: Math.min(h, height - y) };
}

// 从涂抹 mask（原图尺寸像素）计算非空像素包围盒
function maskBoundsRect(maskCanvas: HTMLCanvasElement): MattingRect {
    const ctx = maskCanvas.getContext("2d");
    const { width, height } = maskCanvas;
    if (!ctx || !width || !height) return { x: 0, y: 0, width, height };
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const idx = (y * width + x) * 4 + 3;
            if (data[idx] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) return { x: 0, y: 0, width, height };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
