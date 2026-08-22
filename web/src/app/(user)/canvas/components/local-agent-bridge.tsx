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

/** 展示文案。 */
function statusText(status: LocalAgentStatus) {
    if (status.state === "connected") return `画布 Agent${status.adapter ? ` · ${status.adapter}` : ""}`;
    if (status.state === "connecting") return "正在连接画布 Agent...";
    if (status.state === "error") return "画布 Agent 连接失败";
    return "未连接画布 Agent";
}

/**
 * 画布 Agent 桥接徽标：优先自动探测同源托管端点（/api/agent，服务器部署零配置），
 * 其次使用 URL 参数 agentUrl/agentToken 直连本机或远端 Agent 服务。
 */
export function LocalAgentBridge({ getContext, executeAction }: { getContext: () => unknown; executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult> }) {
    const searchParams = useSearchParams();
    const { message } = App.useApp();
    const [status, setStatus] = useState<LocalAgentStatus>({ state: "idle" });
    const clientRef = useRef<LocalAgentClient | null>(null);

    const url = searchParams.get("agentUrl") || undefined;
    const token = searchParams.get("agentToken") || undefined;
    const hasParams = Boolean(url && token);

    useEffect(() => {
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
        message.info("已断开画布 Agent");
    }, [message]);

    // 无 URL 参数且未探测到托管端点时（探测完成仍 idle），不显示徽标。
    if (!hasParams && status.state === "idle") return null;

    return (
        <div className="absolute right-4 top-4 z-[100] flex items-center gap-1.5 rounded-full border border-stone-300 bg-white/90 px-2.5 py-1 text-xs shadow-sm dark:border-stone-700 dark:bg-stone-900/90">
            <span className="inline-block size-2 rounded-full" style={{ background: STATUS_COLOR[status.state] }} />
            <span className="text-stone-600 dark:text-stone-300">{statusText(status)}</span>
            {status.state === "connected" ? (
                <Tooltip title="断开画布 Agent">
                    <button type="button" onClick={handleDisconnect} className="ml-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200">
                        断开
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}