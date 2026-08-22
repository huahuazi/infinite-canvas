import { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";

export type LocalAgentStatus = { state: "idle" | "connecting" | "connected" | "error"; message?: string; adapter?: string };

export type LocalAgentBridgeOptions = {
    url: string;
    token: string;
    clientId?: string;
    /** 构造当前画布上下文（快照）供浏览器上报。 */
    getContext: () => unknown;
    /** 执行单个画布动作并返回结果（第二参为消息引用节点，桥接场景传空数组）。 */
    executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    onStatusChange?: (status: LocalAgentStatus) => void;
};

/**
 * 本地 Agent 桥：把网页画布连接到本机 Canvas Agent 服务（127.0.0.1）。
 * - 上报画布快照与工具 schema（复用前端 CANVAS_AGENT_TOOLS）
 * - 监听 SSE tool_call 事件，用画布现有执行链路执行并回写结果
 */
export class LocalAgentClient {
    private source: EventSource | null = null;
    private status: LocalAgentStatus = { state: "idle" };
    private stateTimer: ReturnType<typeof setInterval> | null = null;
    private baseUrl: string;
    private token: string;
    private clientId: string;
    private adapter = "";

    constructor(private options: LocalAgentBridgeOptions) {
        this.baseUrl = options.url.replace(/\/+$/, "");
        this.token = options.token;
        this.clientId = options.clientId || `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    async connect() {
        if (this.source) return;
        this.setStatus({ state: "connecting", message: "正在连接本地 Agent..." });
        try {
            const config = await this.fetchJson<{ ok?: boolean; adapters?: Array<{ id: string; label: string }> }>(`${this.baseUrl}/config`);
            if (!config.ok) throw new Error("本地 Agent 服务响应异常");
            this.adapter = config.adapters?.[0]?.id || "";
        } catch (error) {
            this.setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
            return;
        }

        this.source = new EventSource(`${this.baseUrl}/events?clientId=${encodeURIComponent(this.clientId)}&token=${encodeURIComponent(this.token)}`);
        this.source.addEventListener("ready", () => {
            this.setStatus({ state: "connected", message: "已连接本地 Agent", adapter: this.adapter || undefined });
            this.reportState();
            this.stateTimer = setInterval(() => this.reportState(), 2000);
            void this.post("/canvas/activate", {});
        });
        this.source.addEventListener("tool_call", (event) => {
            void this.handleToolCall(event as MessageEvent<string>);
        });
        this.source.onerror = () => {
            this.setStatus({ state: "error", message: "本地 Agent 连接中断" });
        };
    }

    disconnect() {
        if (this.stateTimer) clearInterval(this.stateTimer);
        this.stateTimer = null;
        this.source?.close();
        this.source = null;
        this.setStatus({ state: "idle" });
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
            headers: { "content-type": "application/json", "x-canvas-agent-token": this.token },
            body: JSON.stringify(body),
        });
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, { headers: { "x-canvas-agent-token": this.token } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    private setStatus(status: LocalAgentStatus) {
        this.status = status;
        this.options.onStatusChange?.(status);
    }
}