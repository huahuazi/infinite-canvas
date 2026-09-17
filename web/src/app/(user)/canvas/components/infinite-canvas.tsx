"use client";

import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";

const MIN_CANVAS_SCALE = 0.05;
const MAX_CANVAS_SCALE = 5;
// 指数映射：让触控板捏合的位移和画布缩放比例一一对应，数值越大越灵敏。
const ZOOM_WHEEL_SENSITIVITY = 0.005;

function normalizeWheelDelta(event: { deltaX: number; deltaY: number; deltaMode: number }, pageSize: number, horizontal = false) {
    const raw = horizontal ? event.deltaX : event.deltaY;
    if (event.deltaMode === 1) return raw * 16;
    if (event.deltaMode === 2) return raw * pageSize;
    return raw;
}

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const scaleRef = useRef(viewport.k);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const latestViewportRef = useRef(viewport);
    const zoomFrameRef = useRef<number | null>(null);
    const onViewportChangeRef = useRef(onViewportChange);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        scaleRef.current = viewport.k;
        latestViewportRef.current = viewport;
    }, [viewport]);

    useEffect(() => {
        onViewportChangeRef.current = onViewportChange;
    }, [onViewportChange]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (zoomFrameRef.current) cancelAnimationFrame(zoomFrameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    // 同一帧内的多次滚轮事件合并成一次提交，缩放/平移都按最近一次的视口继续累加，避免抖动。
    const scheduleViewport = (updater: (base: ViewportTransform) => ViewportTransform) => {
        const next = updater(latestViewportRef.current);
        latestViewportRef.current = next;
        if (zoomFrameRef.current) return;
        zoomFrameRef.current = requestAnimationFrame(() => {
            zoomFrameRef.current = null;
            onViewportChangeRef.current(latestViewportRef.current);
        });
    };

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const rect = containerRef.current?.getBoundingClientRect();

        // 双指捏合（macOS 触控板映射为 Ctrl+滚轮）或按住 Cmd/Ctrl 滚轮 -> 缩放，指数映射并锚定鼠标位置。
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            if (!rect) return;
            const delta = -normalizeWheelDelta(event, rect.height);
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
            scheduleViewport((base) => {
                const newScale = Math.min(Math.max(base.k * Math.exp(delta * ZOOM_WHEEL_SENSITIVITY), MIN_CANVAS_SCALE), MAX_CANVAS_SCALE);
                const worldX = (mouseX - base.x) / base.k;
                const worldY = (mouseY - base.y) / base.k;
                return { x: mouseX - worldX * newScale, y: mouseY - worldY * newScale, k: newScale };
            });
            return;
        }

        // 普通滚轮 / 触控板双指滑动 -> 平移画布（与手机地图一致）。
        event.preventDefault();
        const deltaX = normalizeWheelDelta(event, rect?.width ?? 1200, true);
        const deltaY = normalizeWheelDelta(event, rect?.height ?? 800);
        scheduleViewport((base) => ({ x: base.x - deltaX, y: base.y - deltaY, k: base.k }));
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        if (event.button === 0 && isBackgroundClick && document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || document.activeElement instanceof HTMLMediaElement)) document.activeElement.blur();
        const temporaryTool = isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan");

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id],[data-connection-create-menu]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;
            if (event.buttons === 0) {
                panState.current.isPanning = false;
                setIsPanning(false);
                document.body.style.cursor = "";
                return;
            }
            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Safari 的触控板捏合派发非标准 gesture 事件，单独适配；以 gesturestart 时的视口为基准避免累乘。
        let gestureBase: ViewportTransform | null = null;
        const startGesture = (event: Event) => {
            event.preventDefault();
            gestureBase = { ...latestViewportRef.current };
        };
        const applyGesture = (event: Event) => {
            event.preventDefault();
            const gesture = event as Event & { scale: number; clientX: number; clientY: number };
            const base = gestureBase ?? latestViewportRef.current;
            const rect = container.getBoundingClientRect();
            const mouseX = gesture.clientX - rect.left;
            const mouseY = gesture.clientY - rect.top;
            const nextScale = Math.min(Math.max(base.k * gesture.scale, MIN_CANVAS_SCALE), MAX_CANVAS_SCALE);
            const worldX = (mouseX - base.x) / base.k;
            const worldY = (mouseY - base.y) / base.k;
            onViewportChangeRef.current({ x: mouseX - worldX * nextScale, y: mouseY - worldY * nextScale, k: nextScale });
        };
        const endGesture = (event: Event) => {
            event.preventDefault();
            gestureBase = null;
        };

        container.addEventListener("gesturestart", startGesture);
        container.addEventListener("gesturechange", applyGesture);
        container.addEventListener("gestureend", endGesture);
        return () => {
            container.removeEventListener("gesturestart", startGesture);
            container.removeEventListener("gesturechange", applyGesture);
            container.removeEventListener("gestureend", endGesture);
        };
    }, [containerRef]);

    const temporaryTool = isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`, "--canvas-inverse-scale": 1 / viewport.k } as React.CSSProperties}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
