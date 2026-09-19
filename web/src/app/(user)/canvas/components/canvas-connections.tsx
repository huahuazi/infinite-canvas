import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

const CONNECTION_FLOW_COLOR = "#4da3ff";

// 连线的端点与曲线外接框，供绘制和视口裁剪共用同一份几何计算，避免两处公式不一致。
export type ConnectionGeometry = {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    curvature: number;
    // 三次贝塞尔曲线一定落在控制点凸包内，因此取凸包外接框作为连线的完整渲染范围。
    // 目标在源左侧时曲线会在端点之外鼓出，直接用两个端点矩形取并集会漏画，凸包外接框不会。
    bounds: { left: number; right: number; top: number; bottom: number };
};

export function getConnectionGeometry(from: CanvasNodeData, to: CanvasNodeData): ConnectionGeometry {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return {
        startX,
        startY,
        endX,
        endY,
        curvature,
        bounds: {
            left: Math.min(startX, endX - curvature),
            right: Math.max(endX, startX + curvature),
            top: Math.min(startY, endY),
            bottom: Math.max(startY, endY),
        },
    };
}

export function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { startX, startY, endX, endY, curvature } = getConnectionGeometry(from, to);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
            {active ? <path d={pathD} stroke={CONNECTION_FLOW_COLOR} strokeWidth={2} strokeLinecap="round" strokeDasharray="9 31" fill="none" style={{ pointerEvents: "none", animation: "canvas-connection-flow 1s linear infinite", filter: `drop-shadow(0 0 6px ${CONNECTION_FLOW_COLOR}aa)` }} /> : null}
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return (
        <>
            <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />
            <path d={pathD} stroke={CONNECTION_FLOW_COLOR} strokeWidth="2" strokeLinecap="round" strokeDasharray="9 31" fill="none" style={{ animation: "canvas-connection-flow 1s linear infinite" }} />
        </>
    );
}
