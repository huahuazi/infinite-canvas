import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";
/**
 * Claude Code 适配器：spawn `claude -p --output-format stream-json`。
 * 通过会话文件实现简单持久化（Claude CLI 无线程 API，用 --resume 恢复会话）。
 */
export declare class ClaudeCodeAdapter implements AgentAdapter {
    readonly id = "claude-code";
    readonly label = "Claude Code";
    readonly capabilities: readonly ["streaming"];
    private child;
    private sessionRecord;
    start(): Promise<void>;
    startThread(cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    resumeThread(threadId: string, cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    listThreads(opts: {
        cwd: string;
        searchTerm?: string;
        limit?: number;
    }): Promise<{
        data: {
            id: string;
            preview: string;
            name: string | null;
            updatedAt: number;
        }[];
    }>;
    archiveThread(threadId: string): Promise<void>;
    runTurn(prompt: string, emit: AgentEmit, _attachments: AgentAttachment[], options: TurnOptions): Promise<void>;
    interrupt(): Promise<boolean>;
    resolveApproval(): Promise<boolean>;
    listModels(): Promise<never[]>;
    ready(): Promise<boolean>;
}
