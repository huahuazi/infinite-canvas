"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Checkbox, Input, Modal, Tag } from "antd";
import { Bomb, Plus, ScanSearch, Trash2, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { downloadRemoteMedia } from "@/services/file-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { MattingRect } from "@/lib/explode/segment-matting";
import { detectElements } from "@/lib/explode/element-detector";
import type { ExplodeElementOption } from "@/app/(user)/canvas/utils/canvas-explode";

export type CanvasImageExplodePayload = {
    elements: ExplodeElementOption[];
    keepOriginal: boolean;
};

type DrawMode = "draw" | "delete";
type DragHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const handles: DragHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function CanvasNodeExplodeDialog({ dataUrl, open, config, onClose, onConfirm }: { dataUrl: string; open: boolean; config: AiConfig; onClose: () => void; onConfirm: (payload: CanvasImageExplodePayload) => void }) {
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [elements, setElements] = useState<CanvasElement[]>([]);
    const [activeBox, setActiveBox] = useState<number | null>(null);
    const [mode, setMode] = useState<DrawMode>("draw");
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [inpaintKeys, setInpaintKeys] = useState<Set<string>>(new Set());
    const [keepOriginal, setKeepOriginal] = useState(true);
    const [detecting, setDetecting] = useState(false);
    const [manualRect, setManualRect] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
    const [dragging, setDragging] = useState<{ idx: number; handle: DragHandle; start: { x: number; y: number }; rect: MattingRect } | null>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const previewRectRef = useRef<{ width: number; height: number } | null>(null);

    useEffect(() => {
        if (!open) return;
        setMode("draw");
        setActiveBox(null);
        setSelectedKeys(new Set());
        setInpaintKeys(new Set());
        setKeepOriginal(true);
        setElements([]);
        setDetecting(false);
        setManualRect(null);
        setDragging(null);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const runDetect = async () => {
        setDetecting(true);
        try {
            const src = await toRealSource(dataUrl);
            const detected = await detectElements(src, { config });
            if (detected.length) {
                const next = detected.flatMap((item) => normalizeElementRect(item.bbox));
                setElements(next);
                setSelectedKeys(new Set(next.map((_, index) => String(index))));
                setInpaintKeys(new Set(next.map((_, index) => String(index))));
            } else {
                setActiveBox(null);
                setMode("draw");
            }
        } finally {
            setDetecting(false);
        }
    };

    const addManualElement = () => {
        if (!manualRect) return;
        const { start, current } = manualRect;
        const x = (Math.min(start.x, current.x) / previewSize().width) * (image?.width || 1);
        const y = (Math.min(start.y, current.y) / previewSize().height) * (image?.height || 1);
        const w = (Math.abs(current.x - start.x) / previewSize().width) * (image?.width || 1);
        const h = (Math.abs(current.y - start.y) / previewSize().height) * (image?.height || 1);
        if (w < 8 || h < 8) return;
        const id = String(elements.length);
        setElements((prev) => [...prev, { id, name: `元素 ${prev.length + 1}`, bbox: { x, y, width: w, height: h } }]);
        setSelectedKeys((prev) => new Set([...prev, id]));
        setInpaintKeys((prev) => new Set([...prev, id]));
        setManualRect(null);
        setMode("draw");
    };

    const toggleSelect = (id: string) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleInpaint = (id: string) => {
        setInpaintKeys((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const renameElement = (id: string, name: string) => {
        setElements((prev) => prev.map((item) => (item.id === id ? { ...item, name } : item)));
    };

    const deleteElement = (id: string) => {
        setElements((prev) => prev.filter((item) => item.id !== id));
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setInpaintKeys((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setActiveBox(null);
    };

    const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (mode === "delete" || dragging) return;
        const rect = toLocalPoint(event);
        setManualRect({ start: rect, current: rect });
    };
    const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!manualRect) return;
        setManualRect((prev) => prev && { ...prev, current: toLocalPoint(event) });
    };
    const endDraw = () => {
        if (manualRect) addManualElement();
    };

    const startDrag = (idx: number, handle: DragHandle, event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging({ idx, handle, start: toLocalPoint(event), rect: elements[idx].bbox });
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragging) return;
        const point = toLocalPoint(event);
        const dx = ((point.x - dragging.start.x) / previewSize().width) * (image?.width || 1);
        const dy = ((point.y - dragging.start.y) / previewSize().height) * (image?.height || 1);
        setElements((prev) => prev.map((item, index) => (index === dragging.idx ? { ...item, bbox: adjustRect(dragging.rect, dragging.handle, dx, dy, image?.width || 1, image?.height || 1) } : item)));
    };
    const endDrag = () => setDragging(null);

    const toLocalPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = previewRef.current?.getBoundingClientRect();
        if (!box) return { x: 0, y: 0 };
        return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    const previewSize = () => {
        if (previewRectRef.current) return previewRectRef.current;
        return { width: image?.width || 1, height: image?.height || 1 };
    };

    const submit = () => {
        const selected = elements
            .filter((item) => selectedKeys.has(item.id))
            .map((item) => ({
                name: item.name,
                bbox: item.bbox,
                occludedToInpaint: inpaintKeys.has(item.id),
            }));
        if (!selected.length) return;
        onConfirm({ elements: selected, keepOriginal });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_320px]">
                <div className="flex min-h-[440px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div ref={previewRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[70vh] max-w-full bg-transparent" draggable={false} />
                        <div className="absolute inset-0 h-full w-full cursor-crosshair touch-none" onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={endDraw} onPointerCancel={endDraw}>
                            {elements.map((item, index) => (
                                <BoxElement
                                    key={item.id}
                                    rect={item.bbox}
                                    index={index}
                                    active={activeBox === index}
                                    selected={selectedKeys.has(item.id)}
                                    onActivate={() => {
                                        setActiveBox(index);
                                        setMode("draw");
                                    }}
                                    onPointerDown={startDrag}
                                    onPointerMove={moveDrag}
                                    onPointerUp={endDrag}
                                />
                            ))}
                            {manualRect ? <ManualRectBox rect={manualRect} /> : null}
                        </div>
                    </div>
                </div>

                <div className="flex min-h-[440px] flex-col gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">元素爆炸</h2>
                        <p className="mt-1 text-sm opacity-60">识别图内元素，逐个拆成独立透明 PNG</p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button type="primary" icon={<ScanSearch className="size-4" />} onClick={runDetect} loading={detecting}>
                            {detecting ? "识别中…" : "AI 自动识别"}
                        </Button>
                        <Button icon={<Plus className="size-4" />} onClick={() => setMode(mode === "draw" ? "delete" : "draw")}>
                            {mode === "draw" ? "框选添加" : "删除元素"}
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">元素清单（{elements.length}）</span>
                            <span className="opacity-50">勾选=拆出；点亮=补缺口</span>
                        </div>
                        <div className="thin-scrollbar max-h-[220px] space-y-2 overflow-y-auto pr-1">
                            {elements.length === 0 ? (
                                <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm opacity-50">用「框选添加」画框，或点「AI 自动识别」</div>
                            ) : (
                                elements.map((item, index) => (
                                    <div key={item.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${activeBox === index ? "bg-black/5 dark:bg-white/5" : ""}`}>
                                        <Checkbox checked={selectedKeys.has(item.id)} onChange={() => toggleSelect(item.id)} />
                                        <Input className="h-8 flex-1" size="small" value={item.name} onChange={(e) => renameElement(item.id, e.target.value)} onFocus={() => setActiveBox(index)} />
                                        <Button size="small" type={inpaintKeys.has(item.id) ? "primary" : "default"} icon={<WandSparkles className="size-3.5" />} onClick={() => toggleInpaint(item.id)}>
                                            补缺口
                                        </Button>
                                        <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => deleteElement(item.id)} />
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="mt-auto space-y-3">
                        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                            <Checkbox checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)}>
                                保留原图节点
                            </Checkbox>
                            <Tag className="ml-auto" color="orange">
                                方案3 · RMBG为主+AI补缺口
                            </Tag>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<Bomb className="size-4" />} onClick={submit} disabled={!elements.some((item) => selectedKeys.has(item.id))}>
                                {elements.length > 0 ? `爆炸生成 ${elements.filter((item) => selectedKeys.has(item.id)).length} 个 PNG` : "请先添加元素"}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

type CanvasElement = {
    id: string;
    name: string;
    bbox: MattingRect;
    occluded?: boolean;
};

function BoxElement({
    rect,
    index,
    active,
    selected,
    onActivate,
    onPointerDown,
    onPointerMove,
    onPointerUp,
}: {
    rect: MattingRect;
    index: number;
    active: boolean;
    selected: boolean;
    onActivate: () => void;
    onPointerDown: (idx: number, handle: DragHandle, event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
    return (
        <div className={`absolute pointer-events-none ${active ? "z-20" : "z-10"}`} style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}>
            <div className={`absolute cursor-move border-2 ${active ? "border-amber-400" : selected ? "border-[#2f80ff]" : "border-white/80"}`} style={{ inset: 0 }} onPointerDown={(event) => onActivate()}>
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{index + 1}</span>
                {handles.map((handle) => (
                    <div
                        key={handle}
                        className="absolute size-3 rounded-full border bg-white"
                        style={handleStyle(handle)}
                        onPointerDown={(event) => {
                            onActivate();
                            onPointerDown(index, handle, event);
                        }}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                    />
                ))}
            </div>
        </div>
    );
}

function ManualRectBox({ rect }: { rect: { start: { x: number; y: number }; current: { x: number; y: number } } }) {
    const x = Math.min(rect.start.x, rect.current.x);
    const y = Math.min(rect.start.y, rect.current.y);
    const w = Math.abs(rect.current.x - rect.start.x);
    const h = Math.abs(rect.current.y - rect.start.y);
    return <div className="pointer-events-none absolute border-2 border-dashed border-amber-400" style={{ left: x, top: y, width: w, height: h }} />;
}

function handleStyle(handle: DragHandle) {
    const top = handle.includes("n") ? -6 : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? -6 : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` as const };
}

function adjustRect(rect: MattingRect, handle: DragHandle, dx: number, dy: number, width: number, height: number): MattingRect {
    let { x, y, width: w, height: h } = rect;
    if (handle.includes("e")) w += dx;
    if (handle.includes("s")) h += dy;
    if (handle.includes("w")) {
        x += dx;
        w -= dx;
    }
    if (handle.includes("n")) {
        y += dy;
        h -= dy;
    }
    if (handle === "move") {
        x += dx;
        y += dy;
    }
    x = clamp(x, 0, width);
    y = clamp(y, 0, height);
    w = clamp(w, 4, width - x);
    h = clamp(h, 4, height - y);
    return { x, y, width: w, height: h };
}

function normalizeElementRect(bbox: MattingRect): { id: string; name: string; bbox: MattingRect } {
    return { id: String(Math.random()), name: "元素", bbox };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function toRealSource(dataUrl: string): Promise<string> {
    if (/^(data|blob):/i.test(dataUrl)) return dataUrl;
    const blob = await downloadRemoteMedia(dataUrl);
    return URL.createObjectURL(blob);
}
