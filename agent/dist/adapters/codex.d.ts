import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";
/**
 * Codex 适配器：spawn `codex app-server --stdio`，走完整 JSON-RPC 协议。
 * 支持线程、审批、流式、模型列表；Codex turn 会自举画布 MCP。
 */
export declare class CodexAdapter implements AgentAdapter {
    readonly id = "codex";
    readonly label = "Codex";
    readonly capabilities: readonly ["threads", "approvals", "streaming", "skills", "models"];
    private clientPromise;
    private emitRef;
    start(emit: AgentEmit): Promise<void>;
    private getClient;
    startThread(cwd?: string, permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    resumeThread(threadId: string, cwd?: string, permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    listThreads(opts: {
        cwd: string;
        searchTerm?: string;
        limit?: number;
    }): Promise<{
        data: ThreadBrief[];
    }>;
    archiveThread(threadId: string): Promise<void>;
    runTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: TurnOptions): Promise<void>;
    interrupt(threadId?: string): Promise<boolean>;
    resolveApproval(requestId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel"): Promise<boolean>;
    listModels(): Promise<{
        id: string;
        displayName: string;
        defaultReasoningEffort: string;
    }[]>;
    ready(): Promise<boolean>;
}
