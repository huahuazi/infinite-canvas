"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Checkbox, Input, Modal, Slider, Tag } from "antd";
import { Bomb, Brush, Eraser, Plus, ScanSearch, Trash2, WandSparkles, X } from "lucide-react";

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

type DrawMode = "paint" | "erase";
const defaultBrushSize = 90;

// 每个选区一个颜色，便于区分
const regionColors = ["rgba(37, 99, 235, .38)", "rgba(245, 130, 32, .38)", "rgba(226, 75, 74, .38)", "rgba(29, 158, 117, .38)", "rgba(153, 53, 86, .38)", "rgba(133, 79, 11, .38)", "rgba(24, 95, 165, .38)"];

type MaskElement = {
    id: string;
    name: string;
    canvas: HTMLCanvasElement; // 原图尺寸的涂抹 mask，黑色=选区
    occludedToInpaint: boolean;
};

export function CanvasNodeExplodeDialog({ dataUrl, open, config, onClose, onConfirm }: { dataUrl: string; open: boolean; config: AiConfig; onClose: () => void; onConfirm: (payload: CanvasImageExplodePayload) => void }) {
    const { message } = App.useApp();
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [elements, setElements] = useState<MaskElement[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [keepOriginal, setKeepOriginal] = useState(true);
    const [detecting, setDetecting] = useState(false);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const previewRef = useRef<HTMLDivElement>(null);
    const displayCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!open) return;
        setElements([]);
        setActiveId(null);
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setKeepOriginal(true);
        setDetecting(false);
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const activeElement = elements.find((item) => item.id === activeId) || null;

    // 切换激活元素 / 图片尺寸变化时，把所有选区的涂抹 mask 实时渲染到显示层
    useEffect(() => {
        if (!open || !image) return;
        const node = displayCanvasRef.current;
        if (!node) return;
        node.width = image.width;
        node.height = image.height;
        renderAllMasks(true);
    }, [image, activeId, elements, open]);

    const addNewElement = () => {
        if (!image) return;
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const id = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const item: MaskElement = { id, name: `元素 ${elements.length + 1}`, canvas, occludedToInpaint: true };
        setElements((prev) => [...prev, item]);
        setActiveId(id);
        setMode("paint");
        if (previewRef.current) previewRef.current.style.cursor = "crosshair";
    };

    const deleteElement = (id: string) => {
        setElements((prev) => prev.filter((item) => item.id !== id));
        setActiveId((prev) => (prev === id ? null : prev));
    };

    const renameElement = (id: string, name: string) => {
        setElements((prev) => prev.map((item) => (item.id === id ? { ...item, name } : item)));
    };

    const toggleInpaint = (id: string) => {
        setElements((prev) => prev.map((item) => (item.id === id ? { ...item, occludedToInpaint: !item.occludedToInpaint } : item)));
    };

    // 将所有选区的涂抹 mask 叠加渲染到显示层，各自独立颜色，当前激活元素加白边高亮
    const renderAllMasks = (highlightActive = false) => {
        const node = displayCanvasRef.current;
        const ctx = node?.getContext("2d");
        if (!node || !ctx) return;
        ctx.clearRect(0, 0, node.width, node.height);
        elements.forEach((item, index) => {
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
            if (isActive && highlightActive) drawDashedMaskBorder(ctx, item.canvas);
        });
    };

    const readCanvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * (image?.width || rect.width),
            y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * (image?.height || rect.height),
        };
    };

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>, element: MaskElement) => {
        const point = readCanvasPoint(event);
        const ctx = element.canvas.getContext("2d");
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
        renderAllMasks(true);
        drawingRef.current.last = point;
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!activeElement) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        renderAllMasks(true);
        draw(event, activeElement);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active || !activeElement) return;
        event.preventDefault();
        draw(event, activeElement);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!activeElement) return;
        drawingRef.current = { active: false, last: null };
        renderAllMasks(true);
    };

    const runDetect = async () => {
        setDetecting(true);
        try {
            const src = await toRealSource(dataUrl);
            const result = await detectElements(src, { config });
            if (result.elements.length) {
                // 识别结果的 bbox 转为粗 mask：填充矩形选区，用户可再精修
                const next: MaskElement[] = result.elements.map((item) => {
                    const canvas = document.createElement("canvas");
                    canvas.width = image?.width || 1;
                    canvas.height = image?.height || 1;
                    const ctx = canvas.getContext("2d");
                    if (ctx && image) {
                        const px = toPixelRect(item.bbox, image.width, image.height);
                        ctx.fillStyle = "#000";
                        ctx.fillRect(px.x, px.y, px.width, px.height);
                    }
                    const id = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const el: MaskElement = { id, name: item.name, canvas, occludedToInpaint: true };
                    return el;
                });
                setElements((prev) => [...prev, ...next]);
                setActiveId(next[0]?.id || null);
                message.success(`AI 识别出 ${next.length} 个元素，可用画笔精修选区`);
            } else {
                if (result.error) message.warning(result.error);
                else message.info("未识别到元素，请用画笔涂抹");
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "读取图片失败";
            message.error(errorMessage);
        } finally {
            setDetecting(false);
        }
    };

    const submit = () => {
        const valid = elements.filter((item) => canvasHasPaint(item.canvas));
        if (!valid.length) {
            message.warning("请先用画笔涂抹至少一个元素选区");
            return;
        }
        const payload: CanvasImageExplodePayload = {
            elements: valid.map((item) => ({ name: item.name, maskCanvas: item.canvas, occludedToInpaint: item.occludedToInpaint })),
            keepOriginal,
        };
        onConfirm(payload);
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_320px]">
                <div className="flex min-h-[440px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div ref={previewRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[70vh] max-w-full bg-transparent" draggable={false} />
                        {image && activeElement ? (
                            <canvas
                                ref={displayCanvasRef}
                                width={image.width}
                                height={image.height}
                                className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                style={{ pointerEvents: "auto" }}
                                onPointerDown={startDraw}
                                onPointerMove={moveDraw}
                                onPointerUp={stopDraw}
                                onPointerCancel={stopDraw}
                            />
                        ) : null}
                        {image && elements.length === 0 ? (
                            <div className="pointer-events-none absolute inset-0 grid place-items-center">
                                <span className="rounded-lg bg-black/50 px-4 py-2 text-sm text-white">点「添加选区」后，用画笔涂抹元素</span>
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[440px] flex-col gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">元素爆炸</h2>
                        <p className="mt-1 text-sm opacity-60">用画笔涂抹每个元素，逐块拆成独立透明 PNG</p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button type="primary" icon={<ScanSearch className="size-4" />} onClick={runDetect} loading={detecting}>
                            {detecting ? "识别中…" : "AI 自动识别"}
                        </Button>
                        <Button icon={<Plus className="size-4" />} onClick={addNewElement} disabled={!image}>
                            添加选区
                        </Button>
                    </div>

                    {activeElement ? (
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

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">选区清单（{elements.length}）</span>
                            <span className="opacity-50">点亮=补缺口</span>
                        </div>
                        <div className="thin-scrollbar max-h-[200px] space-y-2 overflow-y-auto pr-1">
                            {elements.length === 0 ? (
                                <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm opacity-50">用「添加选区」+ 画笔涂抹，或点「AI 自动识别」</div>
                            ) : (
                                elements.map((item) => {
                                    const has = canvasHasPaint(item.canvas);
                                    return (
                                        <div key={item.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${activeId === item.id ? "bg-black/5 dark:bg-white/5" : ""}`}>
                                            <button type="button" className="size-4 shrink-0 rounded border" style={{ background: has ? "#2f80ff" : "transparent" }} onClick={() => setActiveId(item.id)} aria-label="选中" />
                                            <Input className="h-8 flex-1" size="small" value={item.name} onChange={(e) => renameElement(item.id, e.target.value)} onFocus={() => setActiveId(item.id)} />
                                            <Button size="small" type={item.occludedToInpaint ? "primary" : "default"} icon={<WandSparkles className="size-3.5" />} onClick={() => toggleInpaint(item.id)}>
                                                补缺口
                                            </Button>
                                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={() => deleteElement(item.id)} />
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    <div className="mt-auto space-y-3">
                        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                            <Checkbox checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)}>
                                保留原图节点
                            </Checkbox>
                            <Tag className="ml-auto" color="orange">
                                画笔选区 · RMBG + AI 补缺口
                            </Tag>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<Bomb className="size-4" />} onClick={submit} disabled={!elements.length}>
                                {elements.filter((item) => canvasHasPaint(item.canvas)).length > 0 ? `爆炸生成 ${elements.filter((item) => canvasHasPaint(item.canvas)).length} 个 PNG` : "请先涂抹选区"}
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

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
    }
    return false;
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) return;
    const { width, height } = maskCanvas;
    const data = maskContext.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
    const dash = step * 8;
    const gap = step * 5;
    const period = dash + gap;
    context.save();
    context.fillStyle = "rgba(255,255,255,.72)";
    for (let y = step; y < height - step; y += step) {
        for (let x = step; x < width - step; x += step) {
            const offset = (y * width + x) * 4 + 3;
            if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step)) continue;
            if ((x + y) % period > dash) continue;
            context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
        }
    }
    context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
    return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0;
}

function toPixelRect(bbox: MattingRect, width: number, height: number): MattingRect {
    return {
        x: Math.max(0, Math.min(width, bbox.x)),
        y: Math.max(0, Math.min(height, bbox.y)),
        width: Math.max(1, Math.min(width - bbox.x, bbox.width)),
        height: Math.max(1, Math.min(height - bbox.y, bbox.height)),
    };
}

async function toRealSource(dataUrl: string): Promise<string> {
    if (/^(data|blob):/i.test(dataUrl)) return dataUrl;
    const blob = await downloadRemoteMedia(dataUrl);
    return URL.createObjectURL(blob);
}
