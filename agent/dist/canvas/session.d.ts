import type { Response } from "express";
/** 浏览器上报的画布工具定义（与二开版前端 tools 同构）。 */
export type CanvasToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
        };
    };
};
/** 浏览器上报的画布快照。 */
export type CanvasSnapshot = {
    nodes?: unknown[];
    edges?: unknown[];
    viewport?: unknown;
    [key: string]: unknown;
};
/**
 * 管理浏览器客户端连接、画布状态与挂起的工具调用。
 * 工具真正的执行者在浏览器；本进程只做转发与等待结果回写。
 */
export declare class CanvasSession {
    private clients;
    private clientStates;
    private pendingToolCalls;
    private activeClientId;
    private toolTimeoutMs;
    /** 注册 SSE 连接。 */
    openEvents(clientId: string, res: Response): void;
    /** 更新某个客户端的画布状态与工具 schema。 */
    updateState(clientId: string, body: {
        snapshot?: CanvasSnapshot;
        tools?: CanvasToolDefinition[];
    }): void;
    /** 激活指定客户端（多标签页时切换工具目标）。 */
    activateClient(clientId: string): string;
    /** 当前生效的画布工具清单。 */
    toolDefinitions(): CanvasToolDefinition[];
    /** 是否有已连接且上报过状态的浏览器。 */
    hasCanvas(): boolean;
    /** 当前画布快照。 */
    canvasSnapshot(): CanvasSnapshot | null;
    /**
     * 调用画布工具：向活跃浏览器广播 tool_call 事件并等待执行结果。
     * 浏览器执行后通过 POST /canvas/result 回写。
     */
    callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
    /** 浏览器回写工具执行结果。 */
    resolveResult(clientId: string, body: {
        toolCallId?: string;
        result?: unknown;
        error?: string;
    }): boolean;
    /** 向全部已连接客户端广播事件。 */
    broadcast(type: string, payload: unknown): void;
    /** 协议版本健康信息。 */
    health(): {
        ok: boolean;
        protocolVersion: string;
        clients: number;
        hasCanvas: boolean;
        activeClientId: string;
    };
}
/** 全局单例：HTTP 层与 MCP 子进程通过 REST 共享同一会话语义。 */
export declare const canvasSession: CanvasSession;
