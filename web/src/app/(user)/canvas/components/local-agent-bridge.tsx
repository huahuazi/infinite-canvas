"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Tooltip } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { AGENT_FAILURE_INFO, consumeAgentConnectParams, hasAgentFragment, type AgentConnectParams } from "../agent/agent-connect-params";
import type { CanvasAgentAction, CanvasAgentToolResult } from "../agent/canvas-agent-tools";
import { LocalAgentClient, type LocalAgentStatus } from "../agent/local-agent-client";

/** 状态颜色统一取自画布主题，避免硬编码黑白/stone 分支。 */
function statusColor(status: LocalAgentStatus, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    if (status.state === "connected") return theme.node.activeStroke;
    if (status.state === "connecting") return theme.node.muted;
    if (status.state === "error") return theme.node.text;
    return theme.node.faint;
}

/** 展示文案：失败时直接显示可区分的原因标题。 */
function statusText(status: LocalAgentStatus) {
    if (status.state === "connected") return "画布 Agent 已接入";
    if (status.state === "connecting") return "正在接入画布 Agent…";
    if (status.state === "error") return status.reason ? AGENT_FAILURE_INFO[status.reason].title : "画布 Agent 接入失败";
    return "画布 Agent 未接入";
}

/** 悬浮提示：补充失败原因与下一步动作，避免用户只看到"连接失败"。 */
function statusHint(status: LocalAgentStatus) {
    if (status.state === "connected") return "AI 助手（Codex / Claude 等）已可通过 MCP 操作本画布";
    if (status.state === "connecting") return "正在建立画布与 Agent 服务的连接…";
    if (status.state === "error" && status.reason) {
        const info = AGENT_FAILURE_INFO[status.reason];
        return `${info.title}：${info.detail} 下一步：${info.nextStep}`;
    }
    return "未接入：在画布助手侧边栏展开「接入 Agent」，按当前部署复制 MCP 注册命令即可。";
}

/**
 * 画布 Agent 桥接徽标：凭据只从 URL fragment（#agent=…&token=…）读取并即时清除，query 不再作为凭据来源；
 * 优先按 fragment 直连，其次自动探测同源托管端点（/api/agent，服务器部署零配置）。
 * 连接状态通过 onStatusChange 上报给页面，供侧边栏接入面板展示同一份实时状态与失败原因。
 */
export function LocalAgentBridge({
    getContext,
    executeAction,
    onStatusChange,
}: {
    getContext: () => unknown;
    executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    /** 状态变化回调：页面用它把同一份状态透传给侧边栏接入面板。 */
    onStatusChange?: (status: LocalAgentStatus) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const [status, setStatus] = useState<LocalAgentStatus>({ state: "idle" });
    const clientRef = useRef<LocalAgentClient | null>(null);
    const fragmentParamsRef = useRef<AgentConnectParams | null>(null);
    if (fragmentParamsRef.current === null) fragmentParamsRef.current = consumeAgentConnectParams();
    // consumeAgentConnectParams 已经清空了 hash，所以这里必须用刚读到的参数判断"本次是否带了凭据"，
    // 不能再回头看 window.location.hash（那样恒为 false）。
    const [hasConnection, setHasConnection] = useState(() => Boolean(fragmentParamsRef.current?.url || fragmentParamsRef.current?.token));
    // 用 ref 持有最新回调，避免它进入连接 effect 的依赖而触发重连。
    const onStatusChangeRef = useRef(onStatusChange);
    onStatusChangeRef.current = onStatusChange;

    const url = fragmentParamsRef.current?.url;
    const token = fragmentParamsRef.current?.token;

    const applyStatus = useCallback((next: LocalAgentStatus) => {
        setStatus(next);
        onStatusChangeRef.current?.(next);
    }, []);

    useEffect(() => {
        const onHashChange = () => {
            if (!hasAgentFragment(window.location.hash)) return;
            fragmentParamsRef.current = consumeAgentConnectParams();
            setHasConnection(Boolean(fragmentParamsRef.current.url || fragmentParamsRef.current.token));
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    useEffect(() => {
        let resolveReady = () => {};
        const ready = new Promise<void>((resolve) => {
            resolveReady = resolve;
        });
        const client = new LocalAgentClient({
            url,
            token,
            ready,
            getContext,
            executeAction,
            onStatusChange: applyStatus,
        });
        clientRef.current = client;
        void client.connect();
        // 等布局稳定一帧后再放行：同一次挂载里的重复执行（React 严格模式）只会真正连接一次。
        const frame = window.requestAnimationFrame(() => resolveReady());
        return () => {
            window.cancelAnimationFrame(frame);
            resolveReady();
            client.disconnect();
            clientRef.current = null;
        };
    }, [url, token, getContext, executeAction, applyStatus]);

    const handleDisconnect = useCallback(() => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        applyStatus({ state: "idle" });
        message.info("已断开画布 Agent");
    }, [applyStatus, message]);

    // 未带凭据且同源托管也没探测到（探测完成仍 idle）时不显示徽标。
    if (!hasConnection && status.state === "idle") return null;

    return (
        <div className="absolute bottom-4 left-4 z-[100] flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs shadow-sm" style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
            <span className="inline-block size-2 rounded-full" style={{ background: statusColor(status, theme) }} />
            <Tooltip title={statusHint(status)}>
                <span className="cursor-help">{statusText(status)}</span>
            </Tooltip>
            {status.state === "connected" ? (
                <Tooltip title="断开连接">
                    <button type="button" onClick={handleDisconnect} className="ml-1 cursor-pointer border-0 bg-transparent" style={{ color: theme.node.muted }}>
                        断开
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
