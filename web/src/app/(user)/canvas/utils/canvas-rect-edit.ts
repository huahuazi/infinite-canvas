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
                const hasMask = Boolean(item.maskCanvas && item.maskCanvas.width > 0);

                // 区域高亮：优先涂抹 mask 形状（半透明色，只覆盖涂抹像素），否则矩形
                if (hasMask) {
                    const maskCanvas = item.maskCanvas!;
                    // mask 已与原图同尺寸；绘制半透明 tint，仅涂抹像素可见
                    const tint = document.createElement("canvas");
                    tint.width = options.width;
                    tint.height = options.height;
                    const tintCtx = tint.getContext("2d");
                    if (tintCtx) {
                        tintCtx.clearRect(0, 0, tint.width, tint.height);
                        // 先用 mask 作为 alpha
                        tintCtx.drawImage(maskCanvas, 0, 0, options.width, options.height);
                        tintCtx.globalCompositeOperation = "source-in";
                        // 半透明填充（~40% 可见，让模型看到涂抹形状内部细节）
                        tintCtx.fillStyle = hexWithAlpha(color, 0.42);
                        tintCtx.fillRect(0, 0, tint.width, tint.height);
                        ctx.drawImage(tint, 0, 0);
                        // 沿涂抹形状边缘画细实线轮廓（替代包围盒虚线，避免模型改整个矩形）
                        drawMaskOutline(ctx, maskCanvas, options.width, options.height, color);
                    }
                } else {
                    const rect = normalizeRect(item.bbox!, options.width, options.height);
                    ctx.fillStyle = color + "33";
                    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = Math.max(2, Math.round(Math.min(options.width, options.height) / 300));
                    ctx.setLineDash([6, 5]);
                    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                }

                // 编号角标（用包围盒位置，方便看清编号）
                const rect = hasMask ? maskBoundsRect(item.maskCanvas!) : normalizeRect(item.bbox!, options.width, options.height);
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
        "这是一张带有多个标记区域的图片，每个区域用不同颜色的半透明笔迹覆盖，并带编号。",
        "请严格按编号逐一修改对应标记区域的内容：",
        ...regionLines,
        "要求：",
        "- **只有被半透明彩色笔迹覆盖的像素区域才是修改目标**，笔迹之外（包括同一编号的虚线框内空白处）保持原样",
        "- 笔迹形状即修改范围：沿笔迹形状边缘结束，不要扩散到整个矩形框",
        "- 不要修改任何未标记区域，保持整体构图、人物、光影和风格不变",
        "- 编号文字和彩色笔迹只是编辑标记，不要保留在最终图像中",
        "- 修改内容要与被标记物体本身一致（材质、结构、颜色、风格），而不是凭空重画整个区域",
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

// hex 颜色 + alpha 透明度（0~1）→ rgba 字符串
function hexWithAlpha(hex: string, alpha: number): string {
    const value = hex.replace("#", "");
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 沿涂抹 mask 边缘画细实线轮廓（替代包围盒虚线，让模型知道修改范围是笔迹形状本身）
function drawMaskOutline(ctx: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement, targetWidth: number, targetHeight: number, color: string) {
    const src = document.createElement("canvas");
    src.width = maskCanvas.width;
    src.height = maskCanvas.height;
    const srcCtx = src.getContext("2d");
    if (!srcCtx) return;
    srcCtx.drawImage(maskCanvas, 0, 0);

    // 缩放 mask 到目标尺寸后检测边缘
    const scaled = document.createElement("canvas");
    scaled.width = targetWidth;
    scaled.height = targetHeight;
    const scaledCtx = scaled.getContext("2d");
    if (!scaledCtx) return;
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.drawImage(src, 0, 0, targetWidth, targetHeight);

    const data = scaledCtx.getImageData(0, 0, targetWidth, targetHeight).data;
    const step = Math.max(1, Math.round(Math.max(targetWidth, targetHeight) / 900));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.round(Math.min(targetWidth, targetHeight) / 400));
    ctx.beginPath();
    for (let y = step; y < targetHeight - step; y += step) {
        for (let x = step; x < targetWidth - step; x += step) {
            const idx = (y * targetWidth + x) * 4 + 3;
            if (data[idx] <= 8) continue;
            const isEdge = data[((y - step) * targetWidth + x) * 4 + 3] <= 8 || data[((y + step) * targetWidth + x) * 4 + 3] <= 8 || data[(y * targetWidth + x - step) * 4 + 3] <= 8 || data[(y * targetWidth + x + step) * 4 + 3] <= 8;
            if (isEdge) ctx.rect(x, y, step, step);
        }
    }
    ctx.stroke();
    ctx.restore();
}
