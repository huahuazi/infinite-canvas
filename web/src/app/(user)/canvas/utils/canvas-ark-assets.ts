import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { CanvasArkAsset, CanvasArkAssetKind } from "../types";

// 火山方舟素材库的素材 ID 由平台签发，形如 asset-20260917114721-cmvg9。
// 用户常直接粘贴裸 ID，这里统一补成 asset:// 形式；格式不合法时返回空串。
export function normalizeArkAssetId(value?: string) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^asset:\/\//i.test(text)) return text;
    if (/^asset-[0-9a-z-]+$/i.test(text)) return `asset://${text}`;
    return "";
}

export function createArkAssetEntryId() {
    return `ark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type ArkAssetReferences = {
    images: ReferenceImage[];
    videos: ReferenceVideo[];
    audios: ReferenceAudio[];
};

// 把节点上登记的素材库引用展开成生成接口需要的参考素材。
// 关键点：url 保持 asset:// 原样，video.ts 里的解析层会识别并直接透传，
// 不会做公网转存或 Base64 内联 —— 那样会丢掉素材的身份授权。
export function arkAssetReferences(assets: CanvasArkAsset[] | undefined): ArkAssetReferences {
    const result: ArkAssetReferences = { images: [], videos: [], audios: [] };
    for (const asset of assets || []) {
        const url = normalizeArkAssetId(asset.assetId);
        if (!url) continue;
        const label = asset.name?.trim() || url;
        if (asset.kind === "image") {
            result.images.push({ id: asset.id, name: label, type: "image/png", dataUrl: "", url });
        } else if (asset.kind === "video") {
            result.videos.push({ id: asset.id, name: label, type: "video/mp4", url });
        } else {
            result.audios.push({ id: asset.id, name: label, type: "audio/mpeg", url });
        }
    }
    return result;
}

export const arkAssetKindLabels: Record<CanvasArkAssetKind, string> = {
    image: "参考图",
    video: "参考视频",
    audio: "参考音频",
};
