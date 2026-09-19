import { HOSTED_AGENT_API_BASE } from "./agent-connect-params";
import { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";

/** 连接失败原因，供面板展示可区分的排查文案。 */
export type LocalAgentFailureCode = "token_missing" | "service_offline" | "unauthorized" | "network_blocked" | "protocol_mismatch";

export type LocalAgentStatus = { state: "idle" | "connecting" | "connected" | "error"; reason?: LocalAgentFailureCode; message?: string; adapter?: string; mode?: "hosted" | "direct" };

export type LocalAgentBridgeOptions = {
    /** 直连模式下的服务地址（本机 127.0.0.1 或服务器 IP）。同源托管模式下可为空。 */
    url?: string;
    /** 直连模式使用的 token。托管模式由后端注入，无需提供。 */
    token?: string;
    clientId?: string;
    /** 显式指定部署形态；缺省时按"先直连、再同源托管"的顺序自动判定。 */
    mode?: "auto" | "hosted" | "direct";
    /** await 布局稳定后再建立连接，避免 React 严格模式下的重复挂载抖动。 */
    ready?: Promise<unknown>;
    /** 构造当前画布上下文（快照）供浏览器上报。 */
    getContext: () => unknown;
    /** 执行单个画布动作并返回结果（第二参为消息引用节点，桥接场景传空数组）。 */
    executeAction: (action: CanvasAgentAction, messageReferenceNodeIds: string[]) => Promise<CanvasAgentToolResult>;
    onStatusChange?: (status: LocalAgentStatus) => void;
};

/** 直连/托管探测的超时时间：超过则认为服务未启动，避免界面一直停在"正在连接"。 */
const PROBE_TIMEOUT_MS = 6000;

/** 直连模式意外断流后的重连退避：首次 1s，逐次翻倍，最长 15s；达到上限后停止自动重连，交由用户手动处理。 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_MAX_ATTEMPTS = 6;

function timeoutSignal(ms = PROBE_TIMEOUT_MS) {
    if (typeof AbortSignal === "undefined" || !AbortSignal.timeout) return undefined;
    return AbortSignal.timeout(ms);
}

/** 把网络层异常翻译成可区分的失败原因。 */
function classifyFailure(error: unknown, status = 0): LocalAgentFailureCode {
    if (status === 401 || status === 403) return "unauthorized";
    if (status >= 500) return "service_offline";
    if (status > 0) return "protocol_mismatch";
    if (error instanceof Error) {
        if (error.name === "TimeoutError") return "service_offline";
        const text = `${error.name} ${error.message}`;
        // 浏览器只在"请求根本没到达服务"（网络不通、跨域被拒、混合内容拦截）时抛 TypeError。
        if (error.name === "TypeError" || /failed to fetch|networkerror|load failed|网络/i.test(text)) return "network_blocked";
    }
    return "service_offline";
}

export type HostedProbe = { status: "available" } | { status: "unavailable" } | { status: "broken"; failure: LocalAgentFailureCode };

/**
 * 探测同源托管端点：/api/agent/health 由后端反代到 agent 容器，返回 { ok: true } 即托管可用。
 * 4xx 说明这个部署根本没有托管端点（例如本机 next dev），不算故障，避免无谓地提示"接入失败"。
 */
export async function probeHostedAgent(): Promise<HostedProbe> {
    try {
        const res = await fetch(`${HOSTED_AGENT_API_BASE}/health`, { method: "GET", signal: timeoutSignal() });
        if (res.ok) {
            const body = (await res.json()) as { ok?: boolean };
            return body.ok === true ? { status: "available" } : { status: "broken", failure: "protocol_mismatch" };
        }
        // 5xx：站点反代在，但 agent 容器没起来；4xx：这个部署没有同源托管端点。
        return res.status >= 500 ? { status: "broken", failure: "service_offline" } : { status: "unavailable" };
    } catch (error) {
        return { status: "broken", failure: classifyFailure(error) };
    }
}

/**
 * 本地 Agent 桥：把网页画布连接到 Agent 服务（127.0.0.1 本机或服务器托管）。
 * 两种模式：
 * - hosted（同源托管）：后端反向代理 /api/agent/*，浏览器零配置、token 由服务端注入，继续用 EventSource
 *   （EventSource 自带断线重连）；
 * - direct（直连）：凭据来自 URL fragment，改用 fetch + ReadableStream 读取 SSE，
 *   因为 EventSource 无法自定义请求头，只能把 token 拼进 URL（会进访问日志与 Referer）。
 *   这条路径没有浏览器自带的断线重连，因此自己按退避重连（见 handleStreamDrop）。
 * 连接失败时给出可区分的原因（缺 token / 服务未启动 / token 失效 / 网络或跨域拦截）。
 */
export class LocalAgentClient {
    private source: EventSource | null = null;
    private stream: AbortController | null = null;
    private stateTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** 已进行的自动重连次数；连接成功后归零。 */
    private reconnectAttempt = 0;
    /** 用户主动断开后置为 true：绝不允许再自动重连。 */
    private stopped = false;
    private baseUrl = "";
    private token = "";
    private mode: "hosted" | "direct" = "hosted";
    private clientId: string;
    private adapter = "";

    constructor(private options: LocalAgentBridgeOptions) {
        this.clientId = options.clientId || `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    private get isOpen() {
        return Boolean(this.source || this.stream);
    }

    async connect() {
        if (this.isOpen) return;
        // 重新连接时清掉上一轮遗留的重连定时器与计数，避免并发流与重复退避。
        this.clearReconnectTimer();
        this.stopped = false;
        this.reconnectAttempt = 0;
        this.setStatus({ state: "connecting", message: "正在接入画布 Agent...", mode: this.options.url ? "direct" : "hosted" });
        // 等待布局稳定，避免同一批参数重复连接（例如再次从 fragment 读入凭据时）。
        if (this.options.ready) await this.options.ready;
        if (this.isOpen) return;

        const preferDirect = this.options.mode !== "hosted" && Boolean(this.options.url);
        const hosted: HostedProbe = this.options.mode === "direct" ? { status: "unavailable" } : await probeHostedAgent();

        if (hosted.status === "available") {
            this.mode = "hosted";
            this.baseUrl = HOSTED_AGENT_API_BASE;
            this.token = "";
            this.setStatus({ state: "connecting", message: "正在接入画布 Agent...", mode: "hosted" });
        } else if (preferDirect && this.options.url) {
            // 用户显式带了直连地址：即使同源托管可用也优先按用户意图直连。
            this.mode = "direct";
            this.baseUrl = this.options.url.replace(/\/+$/, "");
            this.token = this.options.token || "";
            if (!this.token) return this.setStatus({ state: "error", reason: "token_missing", mode: "direct" });
            this.setStatus({ state: "connecting", message: "正在接入画布 Agent...", mode: "direct" });
        } else if (hosted.status === "broken") {
            return this.setStatus({ state: "error", reason: hosted.failure, mode: "hosted" });
        } else {
            return this.setStatus({ state: "idle" });
        }

        const ready = await this.fetchJson<{ ok?: boolean; adapters?: Array<{ id: string; label: string }> }>(`${this.baseUrl}/config`);
        if (!ready.ok) return this.setStatus({ state: "error", reason: ready.failure, mode: this.mode });
        this.adapter = ready.body.adapters?.[0]?.id || "";
        // 预检凭据：托管模式由后端注入 token，缺配置时受保护路由返回 401（表现为"连不上又看不出原因"）。
        const guard = await this.probeToken();
        if (guard) return this.setStatus({ state: "error", reason: guard, mode: this.mode });
        this.openStream();
    }

    /** 用户主动断开：置 stopped 后所有断流路径都不再自动重连。 */
    disconnect() {
        this.stopped = true;
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        this.stopStateTimer();
        this.source?.close();
        this.source = null;
        this.stream?.abort();
        this.stream = null;
        this.setStatus({ state: "idle" });
    }

    /** 用受保护路由预检 token：401/403 说明服务端 token 没配好或已失效，与"服务未启动"区分开。 */
    private async probeToken(): Promise<LocalAgentFailureCode | null> {
        try {
            const res = await fetch(`${this.baseUrl}/canvas/state`, { method: "GET", headers: this.token ? { "x-canvas-agent-token": this.token } : {}, signal: timeoutSignal() });
            return res.status === 401 || res.status === 403 ? "unauthorized" : null;
        } catch (error) {
            return classifyFailure(error);
        }
    }

    private openStream() {
        if (this.mode === "direct") {
            // 不 await：SSE 是长连接，readEventStream 会一直读到断开为止，
            // 与托管模式用 EventSource 一样保持"发起连接即返回"。
            void this.openDirectStream();
            return;
        }
        this.openHostedStream();
    }

    /** 托管模式没有浏览器侧凭据（token 由后端反代注入），因此继续使用 EventSource。 */
    private openHostedStream() {
        const source = new EventSource(`${this.baseUrl}/events?clientId=${encodeURIComponent(this.clientId)}`);
        this.source = source;
        source.addEventListener("ready", () => this.handleReady());
        source.addEventListener("tool_call", (event) => {
            void this.handleToolCall((event as MessageEvent<string>).data);
        });
        source.onerror = () => {
            // 连接建立失败与连接中断的排查动作一致：确认服务仍在运行、token 未过期。
            this.setStatus({ state: "error", reason: "service_offline", message: "Agent 连接中断", mode: this.mode });
        };
    }

    /**
     * 直连模式：fetch + ReadableStream 读取 SSE，token 只放在 x-canvas-agent-token 请求头里，
     * 保证凭据不出现在任何请求 URL（URL 会进访问日志、Referer 与浏览器历史）。
     */
    private async openDirectStream() {
        // 同一时刻只允许一条流：已存在时直接返回，避免重连与手动 connect 叠加出并发流。
        if (this.stream) return;
        const controller = new AbortController();
        this.stream = controller;
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/events?clientId=${encodeURIComponent(this.clientId)}`, {
                headers: { accept: "text/event-stream", "x-canvas-agent-token": this.token },
                signal: controller.signal,
            });
        } catch (error) {
            const aborted = controller.signal.aborted;
            this.releaseStream(controller);
            if (aborted) return;
            this.teardown(controller);
            this.handleStreamDrop(classifyFailure(error));
            return;
        }
        if (!response.ok) {
            this.releaseStream(controller);
            this.teardown(controller);
            this.handleStreamDrop(classifyFailure(null, response.status));
            return;
        }
        if (!response.body) {
            this.releaseStream(controller);
            this.teardown(controller);
            this.handleStreamDrop("protocol_mismatch");
            return;
        }
        await this.readEventStream(response.body, controller);
    }

    /** 释放流引用（仅当仍是当前这条流，避免旧流的回调把新流的引用清掉）。 */
    private releaseStream(controller: AbortController) {
        if (this.stream === controller) this.stream = null;
    }

    /** 拆掉已结束/已失败的流，确保不残留悬挂连接；重复 abort 是幂等的。 */
    private teardown(controller: AbortController) {
        if (!controller.signal.aborted) controller.abort();
    }

    /**
     * 直连模式意外断流：如实上报失败原因，然后按退避自动重连。
     * 用户主动断开（stopped）时直接返回，绝不重连。
     */
    private handleStreamDrop(reason: LocalAgentFailureCode) {
        if (this.stopped) return;
        // 流已断，停止上报心跳，等重连成功后由 handleReady 重新建立。
        this.stopStateTimer();
        if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
            this.setStatus({
                state: "error",
                reason,
                message: `Agent 连接中断，已自动重连 ${RECONNECT_MAX_ATTEMPTS} 次仍未恢复`,
                mode: "direct",
            });
            return;
        }
        if (this.reconnectTimer) return;
        this.reconnectAttempt += 1;
        const attempt = this.reconnectAttempt;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        // 重连期间如实上报：先说明断流原因与重连计划，发起重试时再切到 connecting。
        this.setStatus({
            state: "error",
            reason,
            message: `Agent 连接中断，${Math.round(delay / 1000)} 秒后自动重连（第 ${attempt}/${RECONNECT_MAX_ATTEMPTS} 次）`,
            mode: "direct",
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped || this.stream) return;
            this.setStatus({ state: "connecting", message: `正在第 ${attempt}/${RECONNECT_MAX_ATTEMPTS} 次重连画布 Agent...`, mode: "direct" });
            void this.openDirectStream();
        }, delay);
    }

    private clearReconnectTimer() {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private stopStateTimer() {
        if (!this.stateTimer) return;
        clearInterval(this.stateTimer);
        this.stateTimer = null;
    }

    /** 逐帧解析 agent 侧 `event: <类型>\ndata: <JSON>\n\n` 的 SSE 流。 */
    private async readEventStream(body: ReadableStream<Uint8Array>, controller: AbortController) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let boundary = buffer.indexOf("\n\n");
                while (boundary >= 0) {
                    this.dispatchEvent(buffer.slice(0, boundary));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf("\n\n");
                }
            }
            const aborted = controller.signal.aborted;
            this.releaseStream(controller);
            if (aborted) return;
            this.teardown(controller);
            this.handleStreamDrop("service_offline");
        } catch (error) {
            const aborted = controller.signal.aborted;
            this.releaseStream(controller);
            if (aborted) return;
            this.teardown(controller);
            this.handleStreamDrop(classifyFailure(error));
        }
    }

    private dispatchEvent(chunk: string) {
        let type = "";
        const data: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (!type || !data.length) return;
        const payload = data.join("\n");
        if (type === "ready") this.handleReady();
        // 兜底 catch：任何未预期异常都只记录，绝不逃逸成未处理 rejection，也不影响后续帧。
        else if (type === "tool_call") void this.handleToolCall(payload).catch((error) => console.warn("[canvas-agent] 处理 SSE 工具调用帧失败", error));
    }

    private handleReady() {
        // 连接（含重连）成功：重置退避计数，后续断流重新从最短间隔开始。
        this.reconnectAttempt = 0;
        this.setStatus({ state: "connected", message: "已接入画布 Agent", adapter: this.adapter || undefined, mode: this.mode });
        this.reportState();
        this.stopStateTimer();
        this.stateTimer = setInterval(() => this.reportState(), 2000);
        // 显式激活本页面为工具执行目标（多标签/重连场景第一时间生效）。
        void this.post(`/canvas/activate?clientId=${encodeURIComponent(this.clientId)}`, {});
    }

    private async handleToolCall(raw: string) {
        // 解析放进错误处理：畸形/非 JSON 帧只丢弃这一帧，既不产生未处理 rejection，也不中断整条流。
        // 标注成可空是如实反映 JSON.parse 的返回类型——它对 "null"/"42"/"true"/"\"str\"" 都合法返回原始值。
        let payload: { toolCallId?: string; name?: string; input?: unknown } | null;
        try {
            payload = JSON.parse(raw) as { toolCallId?: string; name?: string; input?: unknown } | null;
        } catch {
            console.warn("[canvas-agent] 已忽略无法解析的 SSE 帧", raw.slice(0, 200));
            return;
        }
        // parse 成功但结果不是对象（null / 数字 / 布尔 / 字符串 / 数组）：同样只丢弃这一帧。
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            console.warn("[canvas-agent] 已忽略非对象 SSE 帧", raw.slice(0, 200));
            return;
        }
        const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
        const name = typeof payload.name === "string" ? payload.name : "";
        const input = payload.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : {};
        try {
            const action: CanvasAgentAction = normalizeCanvasAgentAction(name, input);
            const result = await this.options.executeAction(action, []);
            await this.post("/canvas/result", { toolCallId, result });
        } catch (error) {
            await this.post("/canvas/result", { toolCallId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        }
    }

    private reportState() {
        const snapshot = this.options.getContext();
        // 必须带上本页 clientId：否则服务端回退到"首连客户端"，与执行目标 activeClientId 错位，
        // 导致多标签/刷新后 hasCanvas() 恒为 false（MCP 报"没有已连接画布"）。
        void this.post(`/canvas/state?clientId=${encodeURIComponent(this.clientId)}`, { snapshot, tools: CANVAS_AGENT_TOOLS });
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

    private async fetchJson<T>(url: string): Promise<{ ok: true; body: T } | { ok: false; failure: LocalAgentFailureCode }> {
        let response: Response;
        try {
            response = await fetch(url, { headers: this.token ? { "x-canvas-agent-token": this.token } : {}, signal: timeoutSignal() });
        } catch (error) {
            return { ok: false, failure: classifyFailure(error) };
        }
        if (!response.ok) return { ok: false, failure: classifyFailure(null, response.status) };
        try {
            return { ok: true, body: (await response.json()) as T };
        } catch {
            return { ok: false, failure: "protocol_mismatch" };
        }
    }

    private setStatus(status: LocalAgentStatus) {
        this.options.onStatusChange?.(status);
    }
}
