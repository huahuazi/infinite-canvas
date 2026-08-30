"use client";

// 框选修改 —— 主流程编排（画笔版）
// 用户用画笔涂抹多个区域，每块配文字描述，合成为一张「标记图」发给 image-2 编辑。
// 标记图合成逻辑与「局部编辑」一致（验证可行）：
//   原图铺底 → 半透明色 → destination-in 用 mask 裁剪 → destination-over 补回原图
// 每个区域独立显色 + 大号数字编号（AI 依据数字编号对应 prompt 中的"标记区域 N"）。

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

const DEFAULT_REGION_COLORS = ["#f58220", "#2f80ff", "#e24b4a", "#1d9e75", "#854f0b", "#993556", "#185fa5", "#534ab7"];

// 合成标记图：原图打底 + 每个区域按 mask 形状半透明高亮 + 大号数字编号
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
                const hasMask = Boolean(item.maskCanvas && item.maskCanvas.width > 0 && item.maskCanvas.height > 0);

                if (hasMask) {
                    // 与局部编辑一致的合成：先铺半透明色，再用 mask 裁剪，最后补回原图底
                    const maskCanvas = item.maskCanvas!;
                    // 把用户尺寸的 mask 精确缩放到标记图尺寸（避免坐标错位）
                    const scaledMask = document.createElement("canvas");
                    scaledMask.width = options.width;
                    scaledMask.height = options.height;
                    const smCtx = scaledMask.getContext("2d");
                    if (smCtx) {
                        smCtx.imageSmoothingEnabled = true;
                        smCtx.drawImage(maskCanvas, 0, 0, options.width, options.height);
                    }
                    ctx.save();
                    ctx.globalCompositeOperation = "source-over";
                    ctx.fillStyle = hexWithAlpha(color, 0.45);
                    ctx.fillRect(0, 0, options.width, options.height);
                    ctx.globalCompositeOperation = "destination-in";
                    ctx.drawImage(scaledMask, 0, 0);
                    ctx.globalCompositeOperation = "destination-over";
                    ctx.drawImage(image, 0, 0, options.width, options.height);
                    ctx.globalCompositeOperation = "source-over";
                    // 沿涂抹形状画实线轮廓，标出精确修改边界
                    drawMaskOutline(ctx, scaledMask, options.width, options.height, color);
                    ctx.restore();
                } else {
                    const rect = normalizeRect(item.bbox!, options.width, options.height);
                    ctx.save();
                    ctx.fillStyle = hexWithAlpha(color, 0.45);
                    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = Math.max(2, Math.round(Math.min(options.width, options.height) / 300));
                    ctx.setLineDash([6, 5]);
                    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                    ctx.restore();
                }
            });

            // 统一画大号数字编号（画在所有色块之上，保证可见）
            items.forEach((item, index) => {
                const color = (options.regionColors || DEFAULT_REGION_COLORS)[index % (options.regionColors || DEFAULT_REGION_COLORS).length];
                const rect = item.maskCanvas && item.maskCanvas.width > 0 ? maskBoundsRectScaled(item.maskCanvas, options.width / item.maskCanvas.width, options.height / item.maskCanvas.height) : normalizeRect(item.bbox!, options.width, options.height);
                drawRegionNumber(ctx, color, String(index + 1), rect, options.width, options.height);
            });

            resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => reject(new Error("读取原图失败"));
        const src = source.startsWith("data:") || source.startsWith("blob:") ? source : source;
        image.src = src;
    });
}

// 在区域左上角画大号编号（彩色底 + 白字 + 白描边，确保 AI 可见可读）
function drawRegionNumber(ctx: CanvasRenderingContext2D, color: string, label: string, rect: MattingRect, canvasWidth: number, canvasHeight: number) {
    ctx.save();
    const fontSize = Math.max(30, Math.round(Math.min(canvasWidth, canvasHeight) / 26));
    ctx.font = `bold ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(label);
    const pad = Math.round(fontSize * 0.4);
    const bw = metrics.width + pad * 2;
    const bh = fontSize + pad * 1.6;
    const bx = clamp(rect.x, 4, Math.max(4, canvasWidth - bw - 4));
    const by = clamp(rect.y, 4, Math.max(4, canvasHeight - bh - 4));
    // 白描边让编号在任意背景下可见
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(5, Math.round(fontSize / 5));
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.textBaseline = "middle";
    ctx.strokeText(label, bx + pad, by + bh / 2 + 2);
    // 彩色底
    ctx.fillStyle = color;
    ctx.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
    // 白字
    ctx.fillStyle = "#fff";
    ctx.fillText(label, bx + pad, by + bh / 2 + 2);
    ctx.restore();
}

// 组装多区域修改 prompt —— 措辞对齐「局部编辑」验证可行的直白风格
// 不用"数字 N 对区域 N"的抽象映射，直接用「颜色名 + 编号」双锚定：
// 每个区域是什么颜色我明确告诉模型（颜色视觉识别比读数字可靠得多），
// 编号仅作为辅助区分。
export function buildRectEditPrompt(items: RectEditItem[]): string {
    const regionLines = items
        .slice()
        .sort((a, b) => orderIndex(a.id, items) - orderIndex(b.id, items))
        .map((item, index) => {
            const colorName = regionColorName(index % REGION_COLOR_NAMES.length);
            const prompt = item.prompt.trim();
            return `${colorName}区域（编号${index + 1}标记处）：${prompt}`;
        });

    const lines = [
        "参考图中被彩色高亮覆盖的区域是需要修改的位置，不同区域用不同颜色区分，颜色只是编辑标记。",
        "修改要求（按你看到的各颜色区域对应）：",
        ...regionLines,
        "要求：",
        "- 只修改被彩色高亮覆盖的区域，且严格按上面各颜色区域的要求分别修改",
        "- 彩色高亮只是编辑标记，不要保留在最终图像中",
        "- 未标记区域的构图、人物、文字、光影和风格保持不变",
    ];
    return lines.join("\n");
}

// 区域颜色 → 中文颜色名（与标记图渲染色一致，辅助模型锚定）
const REGION_COLOR_NAMES = ["橙色", "蓝色", "红色", "绿色", "棕色", "紫红色", "深蓝色", "紫色"];
function regionColorName(index: number): string {
    return REGION_COLOR_NAMES[index % REGION_COLOR_NAMES.length];
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

// 从涂抹 mask（原图尺寸像素）计算非空像素包围盒（像素坐标）
function maskBoundsRect(maskCanvas: HTMLCanvasElement): MattingRect {
    return maskBoundsRectScaled(maskCanvas, 1, 1);
}

// 从涂抹 mask 计算包围盒，并按缩放因子映射到标记图坐标
function maskBoundsRectScaled(maskCanvas: HTMLCanvasElement, scaleX: number, scaleY: number): MattingRect {
    const ctx = maskCanvas.getContext("2d");
    const { width, height } = maskCanvas;
    if (!ctx || !width || !height) return { x: 0, y: 0, width: 0, height: 0 };
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
    if (maxX < minX || maxY < minY) return { x: 0, y: 0, width: 0, height: 0 };
    return {
        x: minX * scaleX,
        y: minY * scaleY,
        width: (maxX - minX) * scaleX,
        height: (maxY - minY) * scaleY,
    };
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

// 沿涂抹 mask 边缘画细实线轮廓（让模型知道修改范围是笔迹形状本身）
function drawMaskOutline(ctx: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement, targetWidth: number, targetHeight: number, color: string) {
    const src = document.createElement("canvas");
    src.width = maskCanvas.width;
    src.height = maskCanvas.height;
    const srcCtx = src.getContext("2d");
    if (!srcCtx) return;
    srcCtx.drawImage(maskCanvas, 0, 0);

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
