import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = "3";
/**
 * 管理浏览器客户端连接、画布状态与挂起的工具调用。
 * 工具真正的执行者在浏览器；本进程只做转发与等待结果回写。
 */
export class CanvasSession {
    clients = new Map();
    clientStates = new Map();
    pendingToolCalls = new Map();
    activeClientId = "";
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
    /** 注册 SSE 连接。 */
    openEvents(clientId, res) {
        this.clients.set(clientId, res);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        res.write(`event: ready\ndata: {"clientId":"${clientId}"}\n\n`);
        res.on("close", () => this.clients.delete(clientId));
        logger.info("Canvas client connected", { clientId, total: this.clients.size });
        if (!this.activeClientId)
            this.activeClientId = clientId;
    }
    /** 更新某个客户端的画布状态与工具 schema。 */
    updateState(clientId, body) {
        this.clientStates.set(clientId, { snapshot: body.snapshot || { nodes: [], edges: [] }, tools: body.tools || [] });
        if (!this.activeClientId)
            this.activeClientId = clientId;
        logger.debug("Canvas state updated", { clientId, toolCount: (body.tools || []).length });
    }
    /** 激活指定客户端（多标签页时切换工具目标）。 */
    activateClient(clientId) {
        if (this.clients.has(clientId) || this.clientStates.has(clientId))
            this.activeClientId = clientId;
        return this.activeClientId;
    }
    /** 当前生效的画布工具清单。 */
    toolDefinitions() {
        return this.clientStates.get(this.activeClientId)?.tools || [];
    }
    /** 是否有已连接且上报过状态的浏览器。 */
    hasCanvas() {
        return Boolean(this.activeClientId && this.clientStates.has(this.activeClientId));
    }
    /** 当前画布快照。 */
    canvasSnapshot() {
        return this.clientStates.get(this.activeClientId)?.snapshot || null;
    }
    /**
     * 调用画布工具：向活跃浏览器广播 tool_call 事件并等待执行结果。
     * 浏览器执行后通过 POST /canvas/result 回写。
     */
    callTool(name, input) {
        if (!this.hasCanvas())
            return Promise.reject(new Error("当前没有已连接画布，请先在浏览器打开画布并连接本地 Agent"));
        const toolCallId = crypto.randomUUID();
        const response = this.clients.get(this.activeClientId);
        if (!response)
            return Promise.reject(new Error("画布客户端连接已断开，请重新连接"));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingToolCalls.delete(toolCallId);
                reject(new Error(`画布工具 ${name} 执行超时（${Math.round(this.toolTimeoutMs / 1000)}s）`));
            }, this.toolTimeoutMs);
            this.pendingToolCalls.set(toolCallId, { resolve, reject, timer });
            writeEvent(response, "tool_call", { toolCallId, name, input });
            logger.info("Tool call dispatched", { toolCallId, name, clientId: this.activeClientId });
        });
    }
    /** 浏览器回写工具执行结果。 */
    resolveResult(clientId, body) {
        const call = body.toolCallId ? this.pendingToolCalls.get(body.toolCallId) : undefined;
        if (!call)
            return false;
        clearTimeout(call.timer);
        this.pendingToolCalls.delete(body.toolCallId);
        if (body.error)
            call.reject(new Error(body.error));
        else
            call.resolve(body.result);
        logger.info("Tool call resolved", { toolCallId: body.toolCallId, clientId, ok: !body.error });
        return true;
    }
    /** 向全部已连接客户端广播事件。 */
    broadcast(type, payload) {
        for (const res of this.clients.values())
            writeEvent(res, type, payload);
    }
    /** 协议版本健康信息。 */
    health() {
        return { ok: true, protocolVersion: PROTOCOL_VERSION, clients: this.clients.size, hasCanvas: this.hasCanvas(), activeClientId: this.activeClientId || "" };
    }
}
/** 将事件写入 SSE 响应。 */
function writeEvent(res, type, payload) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
/** 全局单例：HTTP 层与 MCP 子进程通过 REST 共享同一会话语义。 */
export const canvasSession = new CanvasSession();
