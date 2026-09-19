export const IMAGE_THUMBNAIL_MAX_EDGE = 512;
export const IMAGE_THUMBNAIL_QUALITY = 0.8;
export const IMAGE_THUMBNAIL_MIME_TYPE = "image/webp";

export type ImageThumbnailSize = {
    width: number;
    height: number;
};

export function resolveThumbnailSize(width: number, height: number, maxEdge = IMAGE_THUMBNAIL_MAX_EDGE): ImageThumbnailSize {
    const safeWidth = Math.max(1, Math.round(width || 1));
    const safeHeight = Math.max(1, Math.round(height || 1));
    const longEdge = Math.max(safeWidth, safeHeight);
    if (longEdge <= maxEdge) return { width: safeWidth, height: safeHeight };
    const scale = maxEdge / longEdge;
    return { width: Math.max(1, Math.round(safeWidth * scale)), height: Math.max(1, Math.round(safeHeight * scale)) };
}

/**
 * 用浏览器原生能力生成缩略图（createImageBitmap + canvas.toBlob）。
 * 仅供 UI 展示使用，原图仍是生成、编辑、下载的唯一数据源。
 * 解码失败、canvas 不可用或环境不支持 WebP 编码时返回 null，由调用方回退原图。
 */
export async function createImageThumbnail(source: Blob): Promise<Blob | null> {
    if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(source);
        const { width, height } = resolveThumbnailSize(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        return await canvasToWebpBlob(canvas);
    } catch {
        return null;
    } finally {
        bitmap?.close();
    }
}

function canvasToWebpBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob | null>((resolve) => {
        try {
            canvas.toBlob(
                (blob) => resolve(blob && blob.type === IMAGE_THUMBNAIL_MIME_TYPE ? blob : null),
                IMAGE_THUMBNAIL_MIME_TYPE,
                IMAGE_THUMBNAIL_QUALITY,
            );
        } catch {
            resolve(null);
        }
    });
}
