"use client";

// 框选修改 —— 主流程编排
// 把多个框选区域合成为一张「标记图」（每个区域半透明色高亮 + 编号 + 边缘描边），
// 交给 createCanvasImageTask（image-2 编辑链路）一次性修改所有区域。
// 返回原尺寸标记图 dataUrl，供页面 handler 发请求。

import type { MattingRect } from "@/lib/explode/segment-matting";

export type RectEditItem = {
    id: string;
    bbox: MattingRect; // 归一化 0~1
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
                const rect = normalizeRect(item.bbox, options.width, options.height);
                const color = (options.regionColors || DEFAULT_REGION_COLORS)[index % (options.regionColors || DEFAULT_REGION_COLORS).length];

                // 区域半透明高亮
                ctx.fillStyle = color + "33";
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

                // 边缘描边
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

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
