"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Checkbox, Input, Modal, Tag } from "antd";
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
    const { message } = App.useApp();
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
    const containerRef = useRef<HTMLDivElement>(null);

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
            const result = await detectElements(src, { config });
            if (result.elements.length) {
                const next = result.elements.flatMap((item) => normalizeElementRect(item.bbox));
                setElements(next);
                setSelectedKeys(new Set(next.map((_, index) => String(index))));
                setInpaintKeys(new Set(next.map((_, index) => String(index))));
            } else {
                if (result.error) message.warning(result.error);
                else message.info("未识别到元素，可手动框选");
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
        if (start.x < 0 || start.y < 0 || current.x < 0 || current.y < 0) return;
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const w = Math.abs(current.x - start.x);
        const h = Math.abs(current.y - start.y);
        if (w < 0.03 || h < 0.03) return; // 归一化阈值，忽略过小误触
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
        setManualRect({ start: toLocalPoint(event), current: toLocalPoint(event) });
    };
    const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!manualRect) return;
        setManualRect((prev) => (prev ? { ...prev, current: toLocalPoint(event) } : prev));
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
        const dx = point.x - dragging.start.x;
        const dy = point.y - dragging.start.y;
        setElements((prev) => prev.map((item, index) => (index === dragging.idx ? { ...item, bbox: adjustRect(dragging.rect, dragging.handle, dx, dy) } : item)));
    };
    const endDrag = () => setDragging(null);

    const toLocalPoint = (event: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
        const box = previewRef.current?.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
        return {
            x: (event.clientX - box.left) / box.width,
            y: (event.clientY - box.top) / box.height,
        };
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
                                    deleteMode={mode === "delete"}
                                    onActivate={() => {
                                        setActiveBox(index);
                                        setMode("draw");
                                    }}
                                    onDelete={() => deleteElement(item.id)}
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
                        <Button
                            icon={<Plus className="size-4" />}
                            type={mode === "draw" ? "primary" : "default"}
                            onClick={() => {
                                setMode("draw");
                                setActiveBox(null);
                            }}
                        >
                            框选添加
                        </Button>
                        <Button icon={<Trash2 className="size-4" />} onClick={() => setMode("delete")} disabled={elements.length === 0}>
                            删除元素
                        </Button>
                        {mode === "draw" ? <span className="self-center text-xs opacity-50">在图上拖动即可框出新元素</span> : null}
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
    deleteMode,
    onActivate,
    onDelete,
    onPointerDown,
    onPointerMove,
    onPointerUp,
}: {
    rect: MattingRect;
    index: number;
    active: boolean;
    selected: boolean;
    deleteMode: boolean;
    onActivate: () => void;
    onDelete: () => void;
    onPointerDown: (idx: number, handle: DragHandle, event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
    return (
        <div className={`absolute ${active ? "z-20" : "z-10"}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
            <div
                className={`absolute border-2 ${deleteMode ? "cursor-pointer border-red-400/80" : "cursor-move"} ${active ? "border-amber-400" : selected ? "border-[#2f80ff]" : "border-white/80"}`}
                style={{ inset: 0 }}
                onPointerDown={(event) => {
                    event.stopPropagation();
                    if (deleteMode) {
                        onDelete();
                    } else {
                        onActivate();
                    }
                }}
            >
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{index + 1}</span>
                {!deleteMode
                    ? handles.map((handle) => (
                          <div
                              key={handle}
                              className="absolute size-3 rounded-full border bg-white"
                              style={handleStyle(handle)}
                              onPointerDown={(event) => {
                                  event.stopPropagation();
                                  onActivate();
                                  onPointerDown(index, handle, event);
                              }}
                              onPointerMove={onPointerMove}
                              onPointerUp={onPointerUp}
                          />
                      ))
                    : null}
            </div>
        </div>
    );
}

function ManualRectBox({ rect }: { rect: { start: { x: number; y: number }; current: { x: number; y: number } } }) {
    const x = Math.min(rect.start.x, rect.current.x) * 100;
    const y = Math.min(rect.start.y, rect.current.y) * 100;
    const w = Math.abs(rect.current.x - rect.start.x) * 100;
    const h = Math.abs(rect.current.y - rect.start.y) * 100;
    return <div className="pointer-events-none absolute border-2 border-dashed border-amber-400" style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }} />;
}

function handleStyle(handle: DragHandle) {
    const top = handle.includes("n") ? -6 : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? -6 : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` as const };
}

function adjustRect(rect: MattingRect, handle: DragHandle, dx: number, dy: number): MattingRect {
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
    x = clamp(x, 0, 1);
    y = clamp(y, 0, 1);
    w = clamp(w, 0.02, 1 - x);
    h = clamp(h, 0.02, 1 - y);
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
