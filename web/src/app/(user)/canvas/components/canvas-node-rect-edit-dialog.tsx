"use client";

// 框选修改（画笔版）—— 用自由画笔涂抹多个区域，每块配文字描述，
// 确认后用 image-2（编辑链路）一次性修改所有涂抹区域。

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider } from "antd";
import { Brush, Eraser, Plus, Trash2, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import type { RectEditItem } from "@/app/(user)/canvas/utils/canvas-rect-edit";

export type CanvasRectEditPayload = {
    items: RectEditItem[];
    keepOriginal: boolean;
};

type DrawMode = "paint" | "erase";
const defaultBrushSize = 90;

// 每个选区一个颜色，便于区分
const regionColors = ["rgba(245, 130, 32, .36)", "rgba(37, 99, 235, .36)", "rgba(226, 75, 74, .36)", "rgba(29, 158, 117, .36)", "rgba(153, 53, 86, .36)", "rgba(133, 79, 11, .36)", "rgba(24, 95, 165, .36)"];

type MaskRegion = {
    id: string;
    prompt: string;
    canvas: HTMLCanvasElement; // 原图尺寸涂抹 mask
};

export function CanvasNodeRectEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasRectEditPayload) => void }) {
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [regions, setRegions] = useState<MaskRegion[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [keepOriginal, setKeepOriginal] = useState(true);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const displayCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!open) return;
        setRegions([]);
        setActiveId(null);
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setKeepOriginal(true);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const activeRegion = regions.find((item) => item.id === activeId) || null;

    // 切换激活区域 / 图片尺寸变化时，把所有区域涂抹 mask 实时渲染到显示层
    useEffect(() => {
        if (!open || !image) return;
        const node = displayCanvasRef.current;
        if (!node) return;
        node.width = image.width;
        node.height = image.height;
        renderAllMasks();
    }, [image, activeId, regions, open]);

    const addRegion = () => {
        if (!image) return;
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const id = `rect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const item: MaskRegion = { id, prompt: "", canvas };
        setRegions((prev) => [...prev, item]);
        setActiveId(id);
    };

    const deleteRegion = (id: string) => {
        setRegions((prev) => prev.filter((item) => item.id !== id));
        setActiveId((prev) => (prev === id ? null : prev));
    };

    const updatePrompt = (id: string, prompt: string) => {
        setRegions((prev) => prev.map((item) => (item.id === id ? { ...item, prompt } : item)));
    };

    // 将所有选区涂抹 mask 叠加渲染到显示层，各自独立颜色，当前激活区域高亮
    const renderAllMasks = () => {
        const node = displayCanvasRef.current;
        const ctx = node?.getContext("2d");
        if (!node || !ctx) return;
        ctx.clearRect(0, 0, node.width, node.height);
        regions.forEach((item, index) => {
            if (!canvasHasPaint(item.canvas)) return;
            const isActive = item.id === activeId;
            const color = isActive ? "rgba(37, 99, 235, .45)" : regionColors[index % regionColors.length];
            const layer = document.createElement("canvas");
            layer.width = node.width;
            layer.height = node.height;
            const layerCtx = layer.getContext("2d");
            if (!layerCtx) return;
            // 独立层：先铺颜色，再用 mask 裁剪（不污染显示层的其它选区）
            layerCtx.fillStyle = color;
            layerCtx.fillRect(0, 0, layer.width, layer.height);
            layerCtx.globalCompositeOperation = "destination-in";
            layerCtx.drawImage(item.canvas, 0, 0);
            // 叠加到显示层
            ctx.drawImage(layer, 0, 0);
        });
    };

    const readCanvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * (image?.width || rect.width),
            y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * (image?.height || rect.height),
        };
    };

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>, region: MaskRegion) => {
        const point = readCanvasPoint(event);
        const ctx = region.canvas.getContext("2d");
        if (!ctx) return;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = brushSize;
        ctx.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        ctx.strokeStyle = "#000";
        ctx.fillStyle = "#000";
        if (!drawingRef.current.last) {
            drawMaskStroke(ctx, point, point, brushSize);
        } else {
            drawMaskStroke(ctx, drawingRef.current.last, point, brushSize);
        }
        renderAllMasks();
        drawingRef.current.last = point;
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!activeRegion) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        renderAllMasks();
        draw(event, activeRegion);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active || !activeRegion) return;
        event.preventDefault();
        draw(event, activeRegion);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!activeRegion) return;
        drawingRef.current = { active: false, last: null };
        renderAllMasks();
    };

    const submit = () => {
        const valid = regions.filter((item) => item.prompt.trim() && canvasHasPaint(item.canvas));
        if (!valid.length) return;
        onConfirm({
            items: valid.map((item) => ({ id: item.id, maskCanvas: item.canvas, prompt: item.prompt.trim() })),
            keepOriginal,
        });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_320px]">
                <div className="flex min-h-[440px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[70vh] max-w-full bg-transparent" draggable={false} />
                        {image && activeRegion ? (
                            <canvas
                                ref={displayCanvasRef}
                                width={image.width}
                                height={image.height}
                                className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                onPointerDown={startDraw}
                                onPointerMove={moveDraw}
                                onPointerUp={stopDraw}
                                onPointerCancel={stopDraw}
                            />
                        ) : null}
                        {image && regions.length === 0 ? (
                            <div className="pointer-events-none absolute inset-0 grid place-items-center">
                                <span className="rounded-lg bg-black/50 px-4 py-2 text-sm text-white">点「添加选区」后用画笔涂抹要修改的区域</span>
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[440px] flex-col gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">框选修改</h2>
                        <p className="mt-1 text-sm opacity-60">画笔涂抹多个区域，每块配文字描述，AI 一次改完</p>
                    </div>

                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addRegion} disabled={!image}>
                        添加选区
                    </Button>

                    {activeRegion ? (
                        <div className="grid grid-cols-2 gap-2">
                            <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                                画笔
                            </Button>
                            <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                                擦除
                            </Button>
                            <div className="col-span-2 space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                    <span className="opacity-70">笔刷大小</span>
                                    <span className="font-semibold">{brushSize}px</span>
                                </div>
                                <Slider min={10} max={220} step={2} value={brushSize} onChange={setBrushSize} />
                            </div>
                        </div>
                    ) : null}

                    <div className="thin-scrollbar max-h-[240px] max-w-[420px] space-y-2 overflow-y-auto pr-1">
                        {regions.length === 0 ? (
                            <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm opacity-50">点「添加选区」后用画笔涂抹，可添加多处</div>
                        ) : (
                            regions.map((item, index) => (
                                <div key={item.id} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${activeId === item.id ? "border-[#2f80ff] bg-black/5 dark:bg-white/5" : "border-transparent"}`}>
                                    <span className="mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-[11px] text-white" style={{ background: regionColorSolid(index) }}>
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
                                    <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => deleteRegion(item.id)} />
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
                            <Button type="primary" icon={<WandSparkles className="size-4" />} onClick={submit} disabled={!regions.some((item) => item.prompt.trim() && canvasHasPaint(item.canvas))}>
                                {regions.some((item) => item.prompt.trim() && canvasHasPaint(item.canvas)) ? `AI 修改 ${regions.filter((item) => item.prompt.trim() && canvasHasPaint(item.canvas)).length} 个区域` : "请涂抹区域并填描述"}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

// 列表角标用不透明色（从 rgba 取 RGB 转 hex）
function regionColorSolid(index: number) {
    const rgba = regionColors[index % regionColors.length];
    const match = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return "#f58220";
    const toHex = (v: string) => Number(v).toString(16).padStart(2, "0");
    return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
    }
    return false;
}
