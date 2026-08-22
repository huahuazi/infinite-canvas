"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { App, Tooltip } from "antd";

import type { CanvasAgentAction, CanvasAgentToolResult } from "../agent/canvas-agent-tools";
import { LocalAgentClient, type LocalAgentStatus } from "../agent/local-agent-client";

/** 本地 Agent 连接徽标颜色。 */
const STATUS_COLOR: Record<LocalAgentStatus["state"], string> = {
    idle: "#9ca3af",
    connecting: "#f59e0b",
    connected: "#22c55e",
    error: "#ef4444",
};

/** 从 URL 参数连接本机 Canvas Agent 服务的画布桥接组件。 */
export function LocalAgentBridge({ getContext, executeAction }: { getContext: () => unknown; executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult> }) {
    const searchParams = useSearchParams();
    const { message } = App.useApp();
    const [status, setStatus] = useState<LocalAgentStatus>({ state: "idle" });
    const clientRef = useRef<LocalAgentClient | null>(null);

    const url = searchParams.get("agentUrl");
    const token = searchParams.get("agentToken");

    useEffect(() => {
        if (!url || !token) return;
        const client = new LocalAgentClient({
            url,
            token,
            getContext,
            executeAction,
            onStatusChange: (next) => setStatus(next),
        });
        clientRef.current = client;
        void client.connect();
        return () => client.disconnect();
    }, [url, token, getContext, executeAction]);

    const handleDisconnect = useCallback(() => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        setStatus({ state: "idle" });
        message.info("已断开本地 Agent");
    }, [message]);

    if (!url || !token) return null;

    return (
        <div className="absolute right-4 top-4 z-[100] flex items-center gap-1.5 rounded-full border border-stone-300 bg-white/90 px-2.5 py-1 text-xs shadow-sm dark:border-stone-700 dark:bg-stone-900/90">
            <span className="inline-block size-2 rounded-full" style={{ background: STATUS_COLOR[status.state] }} />
            <span className="text-stone-600 dark:text-stone-300">
                {status.state === "connected" ? `本地 Agent${status.adapter ? ` · ${status.adapter}` : ""}` : status.state === "connecting" ? "连接中..." : status.state === "error" ? "连接失败" : "未连接"}
            </span>
            {status.state === "connected" ? (
                <Tooltip title="断开本地 Agent">
                    <button type="button" onClick={handleDisconnect} className="ml-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200">
                        断开
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}