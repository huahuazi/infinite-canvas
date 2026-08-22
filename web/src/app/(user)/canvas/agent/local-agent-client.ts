import { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";

export type LocalAgentStatus = { state: "idle" | "connecting" | "connected" | "error"; message?: string; adapter?: string; mode?: "hosted" | "direct" };

export type LocalAgentBridgeOptions = {
    /** 直连模式下的服务地址（本机 127.0.0.1 或服务器 IP）。同源托管模式下可为空。 */
    url?: string;
    /** 直连模式使用的 token。托管模式由后端注入，无需提供。 */
    token?: string;
    clientId?: string;
    /** 构造当前画布上下文（快照）供浏览器上报。 */
    getContext: () => unknown;
    /** 执行单个画布动作并返回结果（第二参为消息引用节点，桥接场景传空数组）。 */
    executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    onStatusChange?: (status: LocalAgentStatus) => void;
};

/**
 * 本地 Agent 桥：把网页画布连接到 Agent 服务（127.0.0.1 本机或服务器托管）。
 * 两种模式：
 * - hosted（同源托管）：后端反向代理 /api/agent/*，浏览器零配置、token 由服务端注入；
 * - direct（直连）：通过 URL 参数 agentUrl/agentToken 连接本机或远端服务。
 * 优先探测同源托管端点，其次使用 URL 参数直连。
 */
export class LocalAgentClient {
    private source: EventSource | null = null;
    private status: LocalAgentStatus = { state: "idle" };
    private stateTimer: ReturnType<typeof setInterval> | null = null;
    private baseUrl = "";
    private token = "";
    private mode: "hosted" | "direct" = "hosted";
    private clientId: string;
    private adapter = "";

    constructor(private options: LocalAgentBridgeOptions) {
        this.clientId = options.clientId || `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    async connect() {
        if (this.source) return;
        this.setStatus({ state: "connecting", message: "正在连接 Agent..." });

        // 1) 优先探测同源托管端点（后端 /api/agent 反代）。
        const hosted = await this.probeHosted();
        if (hosted) {
            this.mode = "hosted";
            this.baseUrl = "/api/agent";
            this.token = "";
        } else if (this.options.url) {
            // 2) 回退直连模式（URL 参数）。
            this.mode = "direct";
            this.baseUrl = this.options.url.replace(/\/+$/, "");
            this.token = this.options.token || "";
            if (!this.token) {
                this.setStatus({ state: "error", message: "直连模式缺少 agentToken" });
                return;
            }
        } else {
            this.setStatus({ state: "idle" });
            return;
        }

        try {
            const config = await this.fetchJson<{ ok?: boolean; adapters?: Array<{ id: string; label: string }> }>(`${this.baseUrl}/config`);
            if (!config.ok) throw new Error("Agent 服务响应异常");
            this.adapter = config.adapters?.[0]?.id || "";
        } catch (error) {
            this.setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
            return;
        }

        const query = `clientId=${encodeURIComponent(this.clientId)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ""}`;
        this.source = new EventSource(`${this.baseUrl}/events?${query}`);
        this.source.addEventListener("ready", () => {
            this.setStatus({ state: "connected", message: "已连接 Agent", adapter: this.adapter || undefined, mode: this.mode });
            this.reportState();
            this.stateTimer = setInterval(() => this.reportState(), 2000);
            // 显式激活本页面为工具执行目标（多标签/重连场景第一时间生效）。
            void this.post(`/canvas/activate?clientId=${encodeURIComponent(this.clientId)}`, {});
        });
        this.source.addEventListener("tool_call", (event) => {
            void this.handleToolCall(event as MessageEvent<string>);
        });
        this.source.onerror = () => {
            this.setStatus({ state: "error", message: "Agent 连接中断" });
        };
    }

    disconnect() {
        if (this.stateTimer) clearInterval(this.stateTimer);
        this.stateTimer = null;
        this.source?.close();
        this.source = null;
        this.setStatus({ state: "idle" });
    }

    private async probeHosted(): Promise<boolean> {
        try {
            const res = await fetch("/api/agent/health", { method: "GET" });
            if (!res.ok) return false;
            const body = (await res.json()) as { ok?: boolean };
            return body.ok === true;
        } catch {
            return false;
        }
    }

    private async handleToolCall(event: MessageEvent<string>) {
        const payload = JSON.parse(event.data) as { toolCallId?: string; name?: string; input?: Record<string, unknown> };
        const toolCallId = payload.toolCallId || "";
        const name = payload.name || "";
        try {
            const action: CanvasAgentAction = normalizeCanvasAgentAction(name, payload.input || {});
            const result = await this.options.executeAction(action, []);
            await this.post("/canvas/result", { toolCallId, result });
        } catch (error) {
            await this.post("/canvas/result", { toolCallId, error: error instanceof Error ? error.message : String(error) });
        }
    }

    private reportState() {
        const snapshot = this.options.getContext();
        void this.post("/canvas/state", { snapshot, tools: CANVAS_AGENT_TOOLS });
    }

    private async post(path: string, body: unknown) {
        await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(this.token ? { "x-canvas-agent-token": this.token } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, { headers: this.token ? { "x-canvas-agent-token": this.token } : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    private setStatus(status: LocalAgentStatus) {
        this.status = status;
        this.options.onStatusChange?.(status);
    }
}