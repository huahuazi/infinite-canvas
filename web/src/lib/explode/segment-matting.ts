"use client";

// 元素爆炸 —— 本地像素级抠图引擎（方案 1：RMBG 保真抠图）
// 用 <script> 运行时注入 @huggingface/transformers UMD 包（挂到 window.transformers），
// 在浏览器 wasm 上跑 RMBG-1.4，对每个元素的 bbox 抠出透明底 PNG。
// 关键：像素级 mask × ROI，不重画、不漂移，保真。原图不上传第三方。
// 兼容 Next 16（Turbopack）：用 script 注入替代 ESM 动态 import，绕开构建解析。

export type MattingRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type MattingOptions = {
    rect?: MattingRect; // 目标区域；不传则整图抠
    maskCanvas?: HTMLCanvasElement; // 用户画笔涂抹的自由选区遮罩（与原图同尺寸），抠图结果与此遮罩求交
    feather?: number; // 边缘羽化半径（默认 2）
    maxEdge?: number; // 处理长边上限（默认 2048），超限先缩放
};

const DEFAULT_FEATHER = 2;
const DEFAULT_MAX_EDGE = 2048;
const CDN_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1/dist/transformers.min.js";

type TransformersModule = {
    pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<(input: string | Blob) => Promise<{ output?: unknown }>>;
    env?: {
        allowLocalModels?: boolean;
        allowRemoteModels?: boolean;
        useBrowserCache?: boolean;
        remoteHost?: string;
        remotePathTemplate?: string;
    };
};

let pipelinePromise: Promise<((input: string | Blob) => Promise<{ output?: unknown }>) | null> | null = null;

// 动态 import 加载浏览器版 transformers（ESM bundle）
// 注意：必须用变量 URL 的 import()，Next/Turbopack 会保留为原生浏览器 import
async function loadTransformers(): Promise<TransformersModule> {
    const url = CDN_URL;
    const mod = (await import(/* webpackIgnore: true */ url)) as TransformersModule;
    if (!mod?.pipeline) throw new Error("transformers 未提供 pipeline");
    // 配置环境：走国内镜像；浏览器缓存仅在 localStorage 可用时才开启
    //（隐私模式/禁用存储/嵌入环境 localStorage 不可用，强行开启会抛
    //  "Browser cache is not available in this environment" 导致加载失败）
    const env = mod.env;
    if (env) {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
        env.useBrowserCache = canUseLocalStorage();
        env.remoteHost = "https://hf-mirror.com";
    }
    return mod;
}

// 探测 localStorage 是否可用（try/catch，某些环境直接抛 SecurityError）
function canUseLocalStorage(): boolean {
    try {
        const key = "__transformer_cache_probe__";
        window.localStorage.setItem(key, "1");
        window.localStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

const MATTING_MODELS = ["briaai/RMBG-1.4", "Xenova/modnet"];

// 记录加载失败原因，供 UI 提示
let mattingError: string | null = null;
export function getMattingError() {
    return mattingError;
}

async function loadMattingRunner(): Promise<((input: string | Blob) => Promise<{ output?: unknown }>) | null> {
    if (pipelinePromise) return pipelinePromise;

    pipelinePromise = (async () => {
        let lastError: unknown = null;
        for (const model of MATTING_MODELS) {
            try {
                const mod = await loadTransformers();
                if (!mod.pipeline) throw new Error("transformers 未提供 pipeline");
                // RMBG-1.4 / modnet 走 image-segmentation pipeline，返回 [{ mask, label, score }]
                const segmenter = await mod.pipeline("image-segmentation", model, {
                    device: "wasm",
                    dtype: "fp32",
                });
                mattingError = null;
                // 包装：把 segmentation 结果归一化为 { output: mask }
                const runner = async (input: string | Blob) => {
                    const result = await segmenter(input);
                    const first = Array.isArray(result) ? result[0] : result;
                    const mask = first?.mask ?? first?.output;
                    if (!mask) return { output: null };
                    return { output: mask };
                };
                return runner;
            } catch (error) {
                lastError = error;
                console.warn(`[segment-matting] 模型 ${model} 加载失败，尝试下一个`, error);
            }
        }
        mattingError = lastError instanceof Error ? lastError.message : "抠图模型加载失败";
        console.error("[segment-matting] 全部抠图模型加载失败", lastError);
        return null;
    })();

    return pipelinePromise;
}

export function isMattingReady() {
    return pipelinePromise !== null;
}

export async function warmUpMatting() {
    await loadMattingRunner();
}

export async function mattingDataUrl(source: string | Blob, options: MattingOptions = {}): Promise<string> {
    const runner = await loadMattingRunner();
    if (!runner) {
        const reason = mattingError || "抠图模型加载失败";
        throw new Error(`本地抠图模型不可用（${reason}）`);
    }

    // 若用户提供了自由涂抹 mask，用其非空包围盒计算紧致 ROI（优于手动画框）
    const mergedOptions = await applyUserMaskRect(options);

    const roiUrl = await buildRoi(source, mergedOptions);
    try {
        const result = await runner(roiUrl);
        const output = result?.output;
        if (!output) throw new Error("抠图模型未返回有效结果");
        return await compositeMatting(roiUrl, output as { data?: Uint8ClampedArray; width?: number; height?: number }, mergedOptions);
    } catch (error) {
        console.warn("[segment-matting] 抠图失败", error);
        throw error instanceof Error ? error : new Error("抠图失败");
    }
}

// 若传了 maskCanvas，从其非空像素计算包围盒作为 rect（紧致 ROI）
async function applyUserMaskRect(options: MattingOptions): Promise<MattingOptions> {
    if (!options.maskCanvas) return options;
    const mask = options.maskCanvas;
    const ctx = mask.getContext("2d");
    if (!ctx) return options;
    const { width, height } = mask;
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
    if (maxX < minX || maxY < minY) return options;
    const pad = Math.max(2, Math.round(Math.min(width, height) / 120));
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width, maxX + pad);
    maxY = Math.min(height, maxY + pad);
    return {
        ...options,
        rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    };
}

async function buildRoi(source: string | Blob, options: MattingOptions): Promise<string> {
    const image = await loadImageElement(source);
    const rect = normalizeRect(options.rect, image.width, image.height);
    const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
    const longEdge = Math.max(rect.width, rect.height);
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return cropFallback(source, options.rect);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

async function compositeMatting(roiUrl: string, output: { data?: Uint8ClampedArray; width?: number; height?: number }, options: MattingOptions): Promise<string> {
    const roiImage = await loadImageElement(roiUrl);
    const width = roiImage.width;
    const height = roiImage.height;
    const feather = options.feather ?? DEFAULT_FEATHER;

    const maskCanvas = await toMaskCanvas(output, width, height);
    if (!maskCanvas) throw new Error("抠图 mask 解析失败");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("抠图画布创建失败");

    context.drawImage(roiImage, 0, 0);
    context.save();
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0, width, height);
    context.restore();

    // 若用户提供了自由涂抹选区 mask（与原图同尺寸），裁剪出对应 ROI 后与 RMBG mask 求交
    if (options.maskCanvas && options.rect) {
        const userMask = cropMaskToRoi(options.maskCanvas, options.rect, width, height);
        if (userMask) {
            context.save();
            context.globalCompositeOperation = "destination-in";
            context.drawImage(userMask, 0, 0, width, height);
            context.restore();
        }
    }

    if (feather > 0) {
        featherAlpha(context, width, height, feather);
    }

    return canvas.toDataURL("image/png");
}

// 把原图尺寸的用户涂抹 mask，裁剪/缩放到 ROI 尺寸（与 roiImage 一致）
function cropMaskToRoi(maskCanvas: HTMLCanvasElement, rect: MattingRect, roiWidth: number, roiHeight: number): HTMLCanvasElement | null {
    const src = document.createElement("canvas");
    src.width = maskCanvas.width;
    src.height = maskCanvas.height;
    const srcCtx = src.getContext("2d");
    if (!srcCtx) return null;
    srcCtx.drawImage(maskCanvas, 0, 0);

    const dst = document.createElement("canvas");
    dst.width = roiWidth;
    dst.height = roiHeight;
    const dstCtx = dst.getContext("2d");
    if (!dstCtx) return null;
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.drawImage(src, rect.x, rect.y, rect.width, rect.height, 0, 0, roiWidth, roiHeight);
    return dst;
}

async function toMaskCanvas(output: { data?: Uint8ClampedArray; width?: number; height?: number }, targetWidth: number, targetHeight: number): Promise<HTMLCanvasElement | null> {
    const srcCanvas = document.createElement("canvas");
    const mh = output.height && output.height > 0 ? Math.floor(output.height) : targetHeight;
    const mw = output.width && output.width > 0 ? Math.floor(output.width) : targetWidth;
    srcCanvas.width = mw;
    srcCanvas.height = mh;
    const srcCtx = srcCanvas.getContext("2d");
    if (!srcCtx) return null;

    if (output.data) {
        // RMBG 输出通常是单通道 mask，需转成 RGBA 灰度图
        const rgba = normalizeMaskToRgba(output.data, mw, mh);
        const imageData = new ImageData(rgba, mw, mh);
        srcCtx.putImageData(imageData, 0, 0);
    } else {
        return null;
    }

    const dst = document.createElement("canvas");
    dst.width = targetWidth;
    dst.height = targetHeight;
    const dstCtx = dst.getContext("2d");
    if (!dstCtx) return null;
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = "high";
    dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    return dst;
}

function normalizeMaskToRgba(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const channels = data.length / (width * height);
    for (let i = 0; i < width * height; i += 1) {
        let v = 0;
        const pixelOffset = i * channels;
        if (channels >= 4) {
            // RGBA：取 alpha 通道
            v = data[pixelOffset + 3];
        } else if (channels === 3) {
            // RGB：取亮度
            v = Math.max(data[pixelOffset], data[pixelOffset + 1], data[pixelOffset + 2]);
        } else {
            // 单通道：直接是 mask 值
            v = data[pixelOffset];
        }
        const out = i * 4;
        rgba[out] = 255;
        rgba[out + 1] = 255;
        rgba[out + 2] = 255;
        rgba[out + 3] = v;
    }
    return rgba;
}

function featherAlpha(context: CanvasRenderingContext2D, width: number, height: number, feather: number) {
    const imageData = context.getImageData(0, 0, width, height);
    const px = imageData.data;
    const alpha = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) alpha[i] = px[i * 4 + 3];
    const blurred = boxBlurAlpha(alpha, width, height, Math.max(1, Math.round(feather)));
    for (let i = 0; i < width * height; i += 1) px[i * 4 + 3] = blurred[i];
    context.putImageData(imageData, 0, 0);
}

function boxBlurAlpha(src: Float32Array, width: number, height: number, radius: number) {
    const tmp = new Float32Array(width * height);
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            let sum = 0;
            let count = 0;
            for (let dx = -radius; dx <= radius; dx += 1) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                sum += src[y * width + nx];
                count += 1;
            }
            tmp[y * width + x] = sum / Math.max(1, count);
        }
    }
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            let sum = 0;
            let count = 0;
            for (let dy = -radius; dy <= radius; dy += 1) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                sum += tmp[ny * width + x];
                count += 1;
            }
            out[y * width + x] = sum / Math.max(1, count);
        }
    }
    return out;
}

function normalizeRect(rect: MattingRect | undefined, width: number, height: number): MattingRect {
    if (!rect) return { x: 0, y: 0, width, height };
    const x = clamp(rect.x, 0, width);
    const y = clamp(rect.y, 0, height);
    const w = clamp(rect.width, 1, width - x);
    const h = clamp(rect.height, 1, height - y);
    return { x, y, width: w, height: h };
}

async function loadImageElement(source: string | Blob): Promise<HTMLImageElement> {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => {
            if (typeof source !== "string") URL.revokeObjectURL(url);
            reject(new Error("读取图片失败"));
        };
        image.src = url;
    });
}

function cropFallback(source: string | Blob, rect?: MattingRect): Promise<string> {
    return loadImageElement(source).then((image) => {
        const r = normalizeRect(rect, image.width, image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, r.width);
        canvas.height = Math.max(1, r.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return typeof source === "string" ? source : canvas.toDataURL();
        ctx.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
    });
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
