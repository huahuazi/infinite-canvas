"use client";

import { useState } from "react";
import { FileText, Image as ImageIcon, KeyRound, Music2, Plus, Video, X } from "lucide-react";
import { Input, Modal, Popover, Radio } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useImageThumbnailSrc } from "@/hooks/use-image-thumbnail-src";
import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "../utils/canvas-resource-references";
import { arkAssetKindLabels, createArkAssetEntryId, normalizeArkAssetId } from "../utils/canvas-ark-assets";
import type { CanvasArkAsset, CanvasArkAssetKind, CanvasNodeData } from "../types";

export function CanvasNodeReferenceBar({ nodeId, connectedNodes, arkAssets, onDisconnect, onStartSelection, onArkAssetsChange }: { nodeId: string; connectedNodes: CanvasNodeData[]; arkAssets?: CanvasArkAsset[]; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void; onArkAssetsChange?: (assets: CanvasArkAsset[]) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const references = buildAllCanvasResourceReferences(connectedNodes);
    const storageKeyByNodeId = new Map(connectedNodes.map((node) => [node.id, node.metadata?.storageKey]));
    const assets = arkAssets || [];
    const [assetDialogOpen, setAssetDialogOpen] = useState(false);
    const removeAsset = (id: string) => onArkAssetsChange?.(assets.filter((asset) => asset.id !== id));
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>参考内容</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map((reference) => <ReferenceItem key={reference.id} reference={reference} storageKey={storageKeyByNodeId.get(reference.nodeId)} onRemove={() => onDisconnect?.(reference.nodeId, nodeId)} />)}
                {assets.map((asset) => <ArkAssetItem key={asset.id} asset={asset} theme={theme} onRemove={() => removeAsset(asset.id)} />)}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title="从画布选择参考节点" onClick={() => onStartSelection?.(nodeId)}>
                    <Plus className="size-4" />
                </button>
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border border-dashed bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title="填写火山素材库素材 ID（虚拟人像 / 已授权真人素材）" onClick={() => setAssetDialogOpen(true)}>
                    <KeyRound className="size-4" />
                </button>
            </div>
            <ArkAssetDialog
                open={assetDialogOpen}
                theme={theme}
                onCancel={() => setAssetDialogOpen(false)}
                onConfirm={(asset) => {
                    onArkAssetsChange?.([...assets, asset]);
                    setAssetDialogOpen(false);
                }}
            />
        </div>
    );
}

function ArkAssetItem({ asset, theme, onRemove }: { asset: CanvasArkAsset; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onRemove: () => void }) {
    const Icon = asset.kind === "image" ? ImageIcon : asset.kind === "video" ? Video : Music2;
    return (
        <Popover
            placement="topLeft"
            mouseEnterDelay={0.15}
            content={
                <div className="max-w-72 space-y-1 text-sm">
                    <div className="font-medium">{arkAssetKindLabels[asset.kind]}{asset.name ? ` · ${asset.name}` : ""}</div>
                    <div className="break-all font-mono text-xs opacity-75">{asset.assetId}</div>
                    <div className="text-xs opacity-60">火山素材库引用，提交时会与当前渠道 API Key 所属账号校验。</div>
                </div>
            }
        >
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border border-dashed" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <Icon className="size-4 opacity-65" />
                <span className="pointer-events-none absolute bottom-0.5 text-[9px] opacity-60">素材</span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label="移除素材引用" title="移除素材引用" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}>
                    <X className="size-3" />
                </button>
            </div>
        </Popover>
    );
}

function ArkAssetDialog({ open, theme, onCancel, onConfirm }: { open: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onCancel: () => void; onConfirm: (asset: CanvasArkAsset) => void }) {
    const [value, setValue] = useState("");
    const [kind, setKind] = useState<CanvasArkAssetKind>("image");
    const [name, setName] = useState("");
    const normalized = normalizeArkAssetId(value);
    const submit = () => {
        if (!normalized) return;
        onConfirm({ id: createArkAssetEntryId(), assetId: normalized, kind, name: name.trim() || undefined });
        setValue("");
        setName("");
    };
    return (
        <Modal open={open} title="添加火山素材库素材" okText="添加" cancelText="取消" onCancel={onCancel} onOk={submit} okButtonProps={{ disabled: !normalized }} destroyOnHidden>
            <div className="space-y-3 pt-1">
                <div>
                    <div className="mb-1 text-xs" style={{ color: theme.node.muted }}>素材 ID</div>
                    <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="asset-20260917114721-cmvg9 或 asset://asset-..." allowClear />
                    <div className="mt-1 text-xs opacity-60">
                        {value.trim() && !normalized ? "格式无法识别：应为 asset://asset-xxx 或 asset-xxx" : "可只粘贴裸素材 ID，系统会自动补上 asset:// 前缀。"}
                    </div>
                </div>
                <div>
                    <div className="mb-1 text-xs" style={{ color: theme.node.muted }}>作为哪种参考素材</div>
                    <Radio.Group value={kind} onChange={(event) => setKind(event.target.value as CanvasArkAssetKind)}>
                        <Radio.Button value="image">{arkAssetKindLabels.image}</Radio.Button>
                        <Radio.Button value="video">{arkAssetKindLabels.video}</Radio.Button>
                        <Radio.Button value="audio">{arkAssetKindLabels.audio}</Radio.Button>
                    </Radio.Group>
                </div>
                <div>
                    <div className="mb-1 text-xs" style={{ color: theme.node.muted }}>备注名称（可选）</div>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：已授权真人 A" />
                </div>
                <div className="text-xs opacity-60">
                    素材必须与当前渠道的 API Key 属于同一火山账号，否则会报「素材不存在或无权访问」。
                </div>
            </div>
        </Modal>
    );
}

function ReferenceItem({ reference, storageKey, onRemove }: { reference: CanvasResourceReference; storageKey?: string; onRemove: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const Icon = reference.kind === "image" ? ImageIcon : reference.kind === "video" ? Video : reference.kind === "audio" ? Music2 : FileText;
    const isMedia = reference.kind === "image" || reference.kind === "video";
    // 条上的小图用缩略图渲染，弹层预览仍用原图。
    const thumbnailSrc = useImageThumbnailSrc(reference.kind === "image" ? storageKey : undefined, reference.previewUrl);
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview reference={reference} />} arrow={!isMedia} destroyOnHidden={reference.kind === "video"} styles={isMedia ? { container: { padding: 0, background: "transparent", boxShadow: "none" } } : undefined}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {reference.kind === "image" && reference.previewUrl ? <img src={thumbnailSrc || undefined} alt="" className="size-full object-cover" /> : reference.kind === "video" && reference.previewUrl ? <video src={reference.previewUrl} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label="断开参考连接" title="断开参考连接" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt={reference.title} className="block max-h-52 max-w-72 rounded-lg object-contain" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="block max-h-52 max-w-72 rounded-lg" autoPlay muted playsInline preload="metadata" />;
    if (reference.kind === "audio" && reference.previewUrl) return <audio src={reference.previewUrl} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{reference.text || reference.title || "暂无内容"}</div>;
}
