// 生图请求的体积收敛：上游（OpenAI 兼容的 /images/edits、chat 多模态）对单张
// 参考图有体积上限，手机原图动辄 3~8MB，直接发必然被拒成 `file too large`。
// 这里只在超阈值时才重绘压缩，未超阈值原样返回，避免无谓的画质损失。

/** 单张参考图的目标字节数。上游常见限制是 4MB，留出 multipart 编码余量。 */
export const IMAGE_UPLOAD_TARGET_BYTES = 3.5 * 1024 * 1024;

/** 原图超过这个尺寸才值得压缩（太小的图压了反而更糊）。 */
const COMPRESS_MIN_BYTES = 1.5 * 1024 * 1024;

/**
 * 逐级降档：先保分辨率降质量，再逐步缩尺寸。
 * 大部分手机照片第一步就能落到阈值内。
 */
const COMPRESS_STEPS = [
    { maxSide: 2560, quality: 0.92 },
    { maxSide: 2048, quality: 0.9 },
    { maxSide: 1792, quality: 0.88 },
    { maxSide: 1536, quality: 0.85 },
    { maxSide: 1280, quality: 0.82 },
    { maxSide: 1024, quality: 0.8 },
];

function canCompress(blob: Blob) {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    const type = (blob.type || "").toLowerCase();
    // GIF / SVG 重绘会丢帧或丢矢量信息，原样放行交给上游判断。
    if (!type.startsWith("image/") || type === "image/gif" || type === "image/svg+xml") return false;
    return typeof createImageBitmap === "function";
}

async function redrawToJpeg(blob: Blob, maxSide: number, quality: number): Promise<Blob | null> {
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(blob);
        const longest = Math.max(bitmap.width, bitmap.height) || 1;
        const scale = Math.min(1, maxSide / longest);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        // JPEG 没有透明通道，先铺白底，否则 PNG 转出来会出现黑底。
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    } catch {
        return null;
    } finally {
        bitmap?.close?.();
    }
}

/**
 * 把超限的参考图压到目标体积内。无法压缩（环境不支持 / 格式特殊）时原样返回，
 * 由上游给出它自己的错误，不在这里假装成功。
 */
export async function compressImageForUpload(blob: Blob, targetBytes = IMAGE_UPLOAD_TARGET_BYTES): Promise<Blob> {
    if (blob.size <= COMPRESS_MIN_BYTES || blob.size <= targetBytes) return blob;
    if (!canCompress(blob)) return blob;
    for (const step of COMPRESS_STEPS) {
        const result = await redrawToJpeg(blob, step.maxSide, step.quality);
        if (!result) return blob;
        if (result.size <= targetBytes) return result;
    }
    // 极端情况（超长图 / 细节极多）：最后再狠压一次，宁可画质降级也别让请求失败。
    return (await redrawToJpeg(blob, 768, 0.72)) || blob;
}

/** 压缩 File 并保持可上传形态；压缩后统一改成 .jpg，避免 filename 与 MIME 对不上。 */
export async function compressImageFileForUpload(file: File, targetBytes = IMAGE_UPLOAD_TARGET_BYTES): Promise<File> {
    const compressed = await compressImageForUpload(file, targetBytes);
    if (compressed === file || compressed.size >= file.size) return file;
    const baseName = (file.name || "reference").replace(/\.[^.]+$/, "");
    return new File([compressed], `${baseName}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
}

/** 把 data URL 里的图片按需压缩，返回新的 data URL（供 chat / responses 的 Base64 内联路径使用）。 */
export async function compressImageDataUrlForUpload(dataUrl: string, targetBytes = IMAGE_UPLOAD_TARGET_BYTES): Promise<string> {
    if (!dataUrl.startsWith("data:")) return dataUrl;
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return dataUrl;
    const meta = dataUrl.slice(0, comma);
    if (!/;base64$/i.test(meta)) return dataUrl;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const mime = meta.slice(5).replace(/;base64$/i, "") || "image/jpeg";
    const blob = new Blob([bytes], { type: mime });
    const compressed = await compressImageForUpload(blob, targetBytes);
    if (compressed === blob) return dataUrl;
    return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || dataUrl));
        reader.onerror = () => resolve(dataUrl);
        reader.readAsDataURL(compressed);
    });
}
