"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, Bookmark, ChevronRight, ClipboardPaste, CloudUpload, Copy, CopyPlus, Crop, Download, Eraser, GalleryHorizontal, GalleryHorizontalEnd, Globe2, Image as ImageIcon, ImagePlus, Images, Layers3, List, Maximize2, Music2, Pencil, Plus, Redo2, RefreshCw, Rotate3d, Scissors, Settings2, Sparkles, Trash2, Undo2, Upload, Video, ZoomIn } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "../types";
import { isCanvasImageNodeType, isPanoramaNodeType } from "../utils/canvas-panorama";
import type { VideoFramePosition } from "../utils/canvas-video-frame";

export type CanvasContextNodeActions = {
    preview: (node: CanvasNodeData) => void;
    saveAsset: (node: CanvasNodeData) => void;
    download: (node: CanvasNodeData) => void;
    upload: (node: CanvasNodeData) => void;
    copyImage: (node: CanvasNodeData) => void;
    copyNodes: () => void;
    duplicate: (node: CanvasNodeData) => void;
    paste: () => void;
    remove: (node: CanvasNodeData) => void;
    editText: (node: CanvasNodeData) => void;
    generateImage: (node: CanvasNodeData) => void;
    reversePrompt: (node: CanvasNodeData) => void;
    captureFrame: (node: CanvasNodeData, position: VideoFramePosition) => void;
    crop: (node: CanvasNodeData) => void;
    split: (node: CanvasNodeData) => void;
    explode: (node: CanvasNodeData) => void;
    rectEdit: (node: CanvasNodeData) => void;
    upscale: (node: CanvasNodeData) => void;
    superResolve: (node: CanvasNodeData) => void;
    angle: (node: CanvasNodeData) => void;
    uploadCloud: (node: CanvasNodeData) => void;
};

export function CanvasNodeContextMenu({ menu, node, actions, onDeleteConnection, onClose }: { menu: ContextMenuState; node: CanvasNodeData | null; actions: CanvasContextNodeActions; onDeleteConnection: () => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    if (menu.type === "connection") {
        return (
            <div className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl" style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()}>
                <MenuButton icon={<Trash2 className="size-4" />} label="删除连线" onClick={onDeleteConnection} danger />
            </div>
        );
    }
    if (!node) return null;

    const run = (action: () => void) => {
        action();
        onClose();
    };
    const hasContent = Boolean(node.metadata?.content);
    const isImage = isCanvasImageNodeType(node.type) && hasContent;
    const isPanorama = isPanoramaNodeType(node.type);
    const isVideo = node.type === CanvasNodeType.Video && hasContent;
    const isAudio = node.type === CanvasNodeType.Audio && hasContent;
    const isText = node.type === CanvasNodeType.Text;
    const divider = <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />;

    return (
        <div className="fixed z-[80] min-w-52 overflow-hidden rounded-xl border py-1 shadow-2xl" style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
            {hasContent ? <MenuButton icon={<Maximize2 className="size-4" />} label={isPanorama ? "进入全景预览" : "放大预览"} onClick={() => run(() => actions.preview(node))} /> : null}
            {isText ? (
                <>
                    <MenuButton icon={<Pencil className="size-4" />} label="编辑文字" onClick={() => run(() => actions.editText(node))} />
                    <MenuButton icon={<ImageIcon className="size-4" />} label="生成图片" onClick={() => run(() => actions.generateImage(node))} />
                </>
            ) : null}
            {isVideo ? (
                <>
                    {divider}
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label="截取首帧" onClick={() => run(() => actions.captureFrame(node, "first"))} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label="截取尾帧" onClick={() => run(() => actions.captureFrame(node, "last"))} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label="截取当前帧" onClick={() => run(() => actions.captureFrame(node, "current"))} />
                </>
            ) : null}
            {hasContent ? (
                <>
                    {divider}
                    <MenuButton icon={<Bookmark className="size-4" />} label="保存到我的资产" onClick={() => run(() => actions.saveAsset(node))} />
                    <MenuButton icon={<Download className="size-4" />} label="下载" onClick={() => run(() => actions.download(node))} />
                    {isImage ? <MenuButton icon={<ImagePlus className="size-4" />} label="复制图片" onClick={() => run(() => actions.copyImage(node))} /> : null}
                    <MenuButton icon={<Upload className="size-4" />} label="上传替换" onClick={() => run(() => actions.upload(node))} />
                    {isImage || isVideo || isAudio ? <MenuButton icon={<CloudUpload className="size-4" />} label="上传到云端" onClick={() => run(() => actions.uploadCloud(node))} /> : null}
                </>
            ) : null}
            {isImage ? (
                <>
                    {divider}
                    <MenuButton icon={<RefreshCw className="size-4" />} label="反转提示词" onClick={() => run(() => actions.reversePrompt(node))} />
                    <MenuButton icon={<Crop className="size-4" />} label="裁剪" onClick={() => run(() => actions.crop(node))} />
                    <MenuButton icon={<Scissors className="size-4" />} label="分割" onClick={() => run(() => actions.split(node))} />
                    <MenuButton icon={<Sparkles className="size-4" />} label="元素爆炸" onClick={() => run(() => actions.explode(node))} />
                    <MenuButton icon={<Eraser className="size-4" />} label="框选修改" onClick={() => run(() => actions.rectEdit(node))} />
                    <MenuButton icon={<ZoomIn className="size-4" />} label="超分辨率" onClick={() => run(() => actions.upscale(node))} />
                    <MenuButton icon={<Rotate3d className="size-4" />} label="多角度" onClick={() => run(() => actions.angle(node))} />
                </>
            ) : null}
            {divider}
            <MenuButton icon={<Copy className="size-4" />} label="复制节点" shortcut="⌘C" onClick={() => run(actions.copyNodes)} />
            <MenuButton icon={<CopyPlus className="size-4" />} label="创建副本" shortcut="⌘D" onClick={() => run(() => actions.duplicate(node))} />
            <MenuButton icon={<ClipboardPaste className="size-4" />} label="粘贴" shortcut="⌘V" onClick={() => run(actions.paste)} />
            <MenuButton icon={<Trash2 className="size-4" />} label="删除" shortcut="⌘⌫" danger onClick={() => run(() => actions.remove(node))} />
        </div>
    );
}

export function CanvasBackgroundContextMenu({
    menu,
    canUndo,
    canRedo,
    onClose,
    onUpload,
    onOpenAssetLibrary,
    onCreateNode,
    onUndo,
    onRedo,
    onPaste,
}: {
    menu: Extract<ContextMenuState, { type: "canvas" }>;
    canUndo: boolean;
    canRedo: boolean;
    onClose: () => void;
    onUpload: () => void;
    onOpenAssetLibrary: () => void;
    onCreateNode: (type: CanvasNodeType) => void;
    onUndo: () => void;
    onRedo: () => void;
    onPaste: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [showAddNode, setShowAddNode] = useState(false);
    const openLeft = typeof window !== "undefined" && menu.x > window.innerWidth - 480;

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    const createNode = (type: CanvasNodeType) => {
        onCreateNode(type);
        onClose();
    };

    return (
        <div
            className="fixed z-[120] min-w-48 rounded-xl border py-1 shadow-2xl"
            style={{ left: Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 220 : menu.x), top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            <MenuButton icon={<Upload className="size-4" />} label="上传" onClick={onUpload} />
            <MenuButton icon={<Images className="size-4" />} label="从素材库选择" onClick={onOpenAssetLibrary} />
            <div className="relative" onMouseEnter={() => setShowAddNode(true)} onMouseLeave={() => setShowAddNode(false)}>
                <MenuButton icon={<Plus className="size-4" />} label="添加节点" trailing={<ChevronRight className="size-4" />} onClick={() => setShowAddNode((value) => !value)} />
                {showAddNode ? (
                    <div className="absolute top-0 grid w-52 gap-0.5 rounded-xl border p-1.5 shadow-2xl" style={{ ...(openLeft ? { right: "100%", marginRight: 6 } : { left: "100%", marginLeft: 6 }), background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
                        {CANVAS_ADD_NODE_ITEMS.map((item) => (
                            <SubMenuButton key={item.type} icon={item.icon} label={item.label} badge={item.badge} onClick={() => createNode(item.type)} />
                        ))}
                    </div>
                ) : null}
            </div>
            <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
            <MenuButton icon={<Undo2 className="size-4" />} label="撤销" shortcut="⌘Z" disabled={!canUndo} onClick={onUndo} />
            <MenuButton icon={<Redo2 className="size-4" />} label="重做" shortcut="⇧⌘Z" disabled={!canRedo} onClick={onRedo} />
            <MenuButton icon={<ClipboardPaste className="size-4" />} label="粘贴" shortcut="⌘V" onClick={onPaste} />
        </div>
    );
}

const CANVAS_ADD_NODE_ITEMS: { type: CanvasNodeType; label: string; badge?: string; icon: ReactNode }[] = [
    { type: CanvasNodeType.Text, label: "文本", icon: <List className="size-4" /> },
    { type: CanvasNodeType.Image, label: "图片", icon: <ImageIcon className="size-4" /> },
    { type: CanvasNodeType.Video, label: "视频", icon: <Video className="size-4" /> },
    { type: CanvasNodeType.Audio, label: "音频", icon: <Music2 className="size-4" /> },
    { type: CanvasNodeType.Panorama, label: "全景图", icon: <Globe2 className="size-4" /> },
    { type: CanvasNodeType.Director, label: "3D 导演台", badge: "NEW", icon: <Layers3 className="size-4" /> },
    { type: CanvasNodeType.Config, label: "配置节点", icon: <Settings2 className="size-4" /> },
];

function SubMenuButton({ icon, label, badge, onClick }: { icon: ReactNode; label: string; badge?: string; onClick: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors" style={{ color: theme.node.text }} onClick={onClick} onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)} onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {badge ? (
                <span className="rounded px-1.5 py-0.5 text-[10px] leading-none" style={{ background: theme.node.fill, color: theme.node.muted }}>
                    {badge}
                </span>
            ) : null}
        </button>
    );
}

function MenuButton({ icon, label, onClick, danger = false, shortcut, disabled = false, trailing }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; shortcut?: string; disabled?: boolean; trailing?: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick} disabled={disabled}>
            {icon}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {shortcut ? <span style={{ color: theme.node.muted }}>{shortcut}</span> : null}
            {trailing}
        </button>
    );
}
