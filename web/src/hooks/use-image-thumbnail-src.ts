"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { IMAGE_THUMBNAIL_MAX_EDGE } from "@/lib/image-thumbnail";
import { resolveThumbnailUrl } from "@/services/image-storage";

export type ImageThumbnailScaleRef = { current: number };

export type ImageThumbnailSrcOptions = {
    /** 图片在画布世界坐标下的宽（例如 node.width）。不传则不按显示尺寸回退原图。 */
    width?: number;
    /** 图片在画布世界坐标下的高（例如 node.height）。 */
    height?: number;
    /** 画布缩放（viewport.k）的当前数值；由父组件在渲染时传入即为响应式。 */
    scale?: number;
    /**
     * 画布缩放（viewport.k）的 ref。画布节点是 React.memo，缩放不会让它们重渲染，
     * 所以 ref 变化不会自动反映到 UI；传它时 hook 会自己观察 ref 并在缩放变化时重新判定。
     */
    scaleRef?: ImageThumbnailScaleRef;
};

// 观察 ref 型缩放来源。所有订阅共用一个 rAF 采样循环，没有订阅时立刻停止，
// 因此列表小图（不传 scaleRef）不会产生任何额外开销。
const scaleListeners = new Set<() => void>();
let scaleFrame: number | null = null;

function stopScaleLoop() {
    if (scaleFrame !== null) cancelAnimationFrame(scaleFrame);
    scaleFrame = null;
}

function runScaleLoop() {
    scaleFrame = null;
    scaleListeners.forEach((listener) => listener());
    if (scaleListeners.size) scheduleScaleLoop();
}

function scheduleScaleLoop() {
    if (scaleFrame !== null || typeof requestAnimationFrame !== "function") return;
    scaleFrame = requestAnimationFrame(runScaleLoop);
}

function subscribeScale(listener: () => void) {
    scaleListeners.add(listener);
    scheduleScaleLoop();
    return () => {
        scaleListeners.delete(listener);
        if (!scaleListeners.size) stopScaleLoop();
    };
}

function subscribeNothing() {
    return () => undefined;
}

function readScale(ref: ImageThumbnailScaleRef | undefined) {
    const value = Number(ref?.current);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function currentDevicePixelRatio() {
    return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** data: URL 型原图本身就是解码产物，解析期先渲染它等于把大图解码做了，所以这类允许短暂空白。 */
function isInlineDataUrl(src: string) {
    return src.startsWith("data:");
}

/**
 * 列表/节点展示用的图片地址：优先本地缩略图，需要更高清晰度或缩略图缺失时回退原图。
 *
 * - 默认（不传 width/height/scale）：有缩略图就用缩略图。40px/48px/36px 这类列表行与 chip 都属于这一档，
 *   它们在任何缩放级别下都不会超过 IMAGE_THUMBNAIL_MAX_EDGE，必须一直用缩略图。
 * - 传了世界尺寸与缩放时：显示设备像素 = 世界尺寸 × 画布缩放 × devicePixelRatio，
 *   超过 IMAGE_THUMBNAIL_MAX_EDGE 说明缩略图会被放大显示，此时改用原图（三项缺一不可）。
 * - 缩略图缺失或读取失败：回退原图。
 *
 * 缩略图只用于展示；查看大图、下载、送入生成、编辑一律走原图，不受本 hook 影响。
 */
export function useImageThumbnailSrc(storageKey: string | undefined, originalSrc: string | undefined, options: ImageThumbnailSrcOptions = {}) {
    const { width, height, scale, scaleRef } = options;
    const observedScale = useSyncExternalStore(scaleRef ? subscribeScale : subscribeNothing, () => readScale(scaleRef), () => 1);
    const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setThumbnailSrc(null);
        if (!storageKey) return;
        resolveThumbnailUrl(storageKey)
            .then((url) => {
                if (!cancelled) setThumbnailSrc(url || "");
            })
            .catch(() => {
                if (!cancelled) setThumbnailSrc("");
            });
        return () => {
            cancelled = true;
        };
    }, [storageKey]);

    const original = originalSrc || "";
    if (!storageKey) return original;

    const worldLongEdge = Math.max(Number(width) || 0, Number(height) || 0);
    if (worldLongEdge > 0 && worldLongEdge * (scale ?? observedScale) * currentDevicePixelRatio() > IMAGE_THUMBNAIL_MAX_EDGE) return original;

    if (thumbnailSrc === null) return isInlineDataUrl(original) ? "" : original;
    return thumbnailSrc || original;
}
