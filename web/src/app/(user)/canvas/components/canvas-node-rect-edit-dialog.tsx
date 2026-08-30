"use client";

// 框选修改 —— 类似画笔局部编辑，但用矩形框选代替笔刷，支持一图多框。
// 每个框选区域配一条文字描述，确认后用 image-2 一次性修改所有框选区域。
// 复用 createCanvasImageTask（image-2 编辑链路），通过「标记图 + 分区域 prompt」驱动。

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal } from "antd";
import { Eraser, Plus, Trash2, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { downloadRemoteMedia } from "@/services/file-storage";
import type { MattingRect } from "@/lib/explode/segment-matting";

export type CanvasRectEditItem = {
    id: string;
    bbox: MattingRect; // 归一化 0~1
    prompt: string; // 该区域的修改描述
};

export type CanvasRectEditPayload = {
    items: CanvasRectEditItem[];
    keepOriginal: boolean;
};

type DragHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const handles: DragHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const regionColors = ["#2f80ff", "#f58220", "#e24b4a", "#1d9e75", "#854f0b", "#993556", "#185fa5"];

export function CanvasNodeRectEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasRectEditPayload) => void }) {
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [items, setItems] = useState<CanvasRectEditItem[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [manualRect, setManualRect] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
    const [dragging, setDragging] = useState<{ id: string; handle: DragHandle; start: { x: number; y: number }; rect: MattingRect } | null>(null);
    const [keepOriginal, setKeepOriginal] = useState(true);
    const [onBoxDrawing, setOnBoxDrawing] = useState(false);
    const previewRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setItems([]);
        setActiveId(null);
        setManualRect(null);
        setDragging(null);
        setKeepOriginal(true);
        setOnBoxDrawing(false);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const toLocalPoint = (event: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
        const box = previewRef.current?.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
        return {
            x: (event.clientX - box.left) / box.width,
            y: (event.clientY - box.top) / box.height,
        };
    };

    const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (dragging) return;
        setManualRect({ start: toLocalPoint(event), current: toLocalPoint(event) });
    };
    const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!manualRect) return;
        setManualRect((prev) => (prev ? { ...prev, current: toLocalPoint(event) } : prev));
    };
    const endDraw = () => {
        if (!manualRect) return;
        const { start, current } = manualRect;
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const w = Math.abs(current.x - start.x);
        const h = Math.abs(current.y - start.y);
        if (w >= 0.03 && h >= 0.03) {
            const id = `rect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            setItems((prev) => [...prev, { id, bbox: { x, y, width: w, height: h }, prompt: "" }]);
            setActiveId(id);
            setOnBoxDrawing(false);
        }
        setManualRect(null);
    };

    const startDrag = (id: string, handle: DragHandle, event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const target = items.find((item) => item.id === id);
        if (!target) return;
        setDragging({ id, handle, start: toLocalPoint(event), rect: target.bbox });
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragging) return;
        const point = toLocalPoint(event);
        const dx = point.x - dragging.start.x;
        const dy = point.y - dragging.start.y;
        setItems((prev) => prev.map((item) => (item.id === dragging.id ? { ...item, bbox: adjustRect(dragging.rect, dragging.handle, dx, dy) } : item)));
    };
    const endDrag = () => setDragging(null);

    const updatePrompt = (id: string, prompt: string) => {
        setItems((prev) => prev.map((item) => (item.id === id ? { ...item, prompt } : item)));
    };
    const deleteItem = (id: string) => {
        setItems((prev) => prev.filter((item) => item.id !== id));
        setActiveId((prev) => (prev === id ? null : prev));
    };

    const submit = () => {
        const validItems = items.filter((item) => item.prompt.trim());
        if (!validItems.length) return;
        onConfirm({ items: validItems, keepOriginal });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_320px]">
                <div className="flex min-h-[440px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div ref={previewRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[70vh] max-w-full bg-transparent" draggable={false} />
                        <div
                            className={`absolute inset-0 h-full w-full ${onBoxDrawing ? "cursor-crosshair" : "cursor-default"} touch-none`}
                            onPointerDown={onBoxDrawing ? startDraw : undefined}
                            onPointerMove={onBoxDrawing ? moveDraw : undefined}
                            onPointerUp={onBoxDrawing ? endDraw : undefined}
                            onPointerCancel={onBoxDrawing ? endDraw : undefined}
                        >
                            {items.map((item, index) => (
                                <BoxRegion
                                    key={item.id}
                                    id={item.id}
                                    rect={item.bbox}
                                    index={index}
                                    color={regionColors[index % regionColors.length]}
                                    active={activeId === item.id}
                                    onActivate={() => setActiveId(item.id)}
                                    onDelete={() => deleteItem(item.id)}
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
                        <h2 className="text-xl font-semibold">框选修改</h2>
                        <p className="mt-1 text-sm opacity-60">框选区域 + 文字描述，用 AI 一次修改多个区域</p>
                    </div>

                    <Button type={onBoxDrawing ? "primary" : "default"} icon={<Plus className="size-4" />} onClick={() => setOnBoxDrawing((prev) => !prev)}>
                        {onBoxDrawing ? "在图上拖动框选…" : "框选区域"}
                    </Button>

                    <div className="thin-scrollbar max-h-[240px] max-w-[420px] space-y-2 overflow-y-auto pr-1">
                        {items.length === 0 ? (
                            <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm opacity-50">点「框选区域」后在图上拖动，可框多处</div>
                        ) : (
                            items.map((item, index) => (
                                <div key={item.id} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${activeId === item.id ? "border-[#2f80ff] bg-black/5 dark:bg-white/5" : "border-transparent"}`}>
                                    <span className="mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-[11px] text-white" style={{ background: regionColors[index % regionColors.length] }}>
                                        {index + 1}
                                    </span>
                                    <div className="flex-1 space-y-1">
                                        <Input.TextArea
                                            autoSize={{ minRows: 1, maxRows: 3 }}
                                            value={item.prompt}
                                            placeholder="例如：把这块区域改成金属质感"
                                            onChange={(event) => updatePrompt(item.id, event.target.value)}
                                            onFocus={() => setActiveId(item.id)}
                                        />
                                    </div>
                                    <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => deleteItem(item.id)} />
                                </div>
                            ))
                        )}
                    </div>

                    <div className="mt-auto space-y-3">
                        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                            <input type="checkbox" checked={keepOriginal} onChange={(event) => setKeepOriginal(event.target.checked)} aria-label="保留原图" />
                            <span className="text-sm">保留原图节点</span>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} onClick={submit} disabled={!items.some((item) => item.prompt.trim())}>
                                {items.some((item) => item.prompt.trim()) ? `AI 修改 ${items.filter((item) => item.prompt.trim()).length} 个区域` : "请至少给一个区域填描述"}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function BoxRegion({
    id,
    rect,
    index,
    color,
    active,
    onActivate,
    onDelete,
    onPointerDown,
    onPointerMove,
    onPointerUp,
}: {
    id: string;
    rect: MattingRect;
    index: number;
    color: string;
    active: boolean;
    onActivate: () => void;
    onDelete: () => void;
    onPointerDown: (id: string, handle: DragHandle, event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
    return (
        <div className="absolute" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
            <div
                className={`absolute cursor-move border-2`}
                style={{ inset: 0, borderColor: active ? color : `${color}99`, background: `${color}22` }}
                onPointerDown={(event) => {
                    event.stopPropagation();
                    onActivate();
                }}
            >
                <span className="absolute left-1 top-1 rounded px-1 text-[10px] text-white" style={{ background: color }}>
                    {index + 1}
                </span>
                <button
                    type="button"
                    className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={onDelete}
                    aria-label="删除区域"
                >
                    <Eraser className="size-2.5" />
                </button>
                {handles.map((handle) => (
                    <div
                        key={handle}
                        className="absolute size-3 rounded-full border bg-white"
                        style={handleStyle(handle)}
                        onPointerDown={(event) => {
                            event.stopPropagation();
                            onActivate();
                            onPointerDown(id, handle, event);
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

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
