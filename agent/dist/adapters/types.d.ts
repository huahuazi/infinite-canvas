import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
/** Agent 能力标记，前端据此渲染能力差异。 */
export type AgentCapability = "threads" | "approvals" | "streaming" | "skills" | "models";
/** 线程摘要。 */
export type ThreadBrief = {
    id: string;
    preview?: string;
    name?: string | null;
    cwd?: string;
    status?: string;
    updatedAt?: number;
};
/** 一次 turn 的输入。 */
export type TurnOptions = {
    attachments?: AgentAttachment[];
    threadId?: string;
    cwd?: string;
    permissionMode?: AgentPermissionMode;
    model?: string;
    messageText?: string;
    onStart?: () => void;
    onThread?: (threadId: string) => void;
    onTurn?: (turnId: string) => void;
    onFinish?: () => void;
    onDelta?: (delta: {
        type: string;
        text?: string;
        itemId?: string;
    }) => void;
};
/** 审批决定。 */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
/**
 * Agent 适配器接口。每个实现封装一种 Agent 后端的连接与对话协议，
 * 统一向 HTTP 层暴露画布无关的能力。事件统一经 AgentEmit 广播给网页。
 */
export interface AgentAdapter {
    id: string;
    label: string;
    readonly capabilities: readonly AgentCapability[];
    /** 启动连接（Codex app-server / CLI 预热等）。 */
    start(emit: AgentEmit): Promise<void>;
    /** 创建新会话线程。 */
    startThread(cwd?: string, permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    /** 恢复既有线程。 */
    resumeThread(threadId: string, cwd?: string, permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    /** 列出线程。 */
    listThreads(opts: {
        cwd: string;
        searchTerm?: string;
        limit?: number;
    }): Promise<{
        data: ThreadBrief[];
    }>;
    /** 归档线程。 */
    archiveThread(threadId: string): Promise<void>;
    /** 执行一轮对话。 */
    runTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: TurnOptions): Promise<void>;
    /** 中断当前 turn。 */
    interrupt(threadId?: string): Promise<boolean>;
    /** 答复待审批请求。 */
    resolveApproval(requestId: string, decision: ApprovalDecision): Promise<boolean>;
    /** 可用模型列表。 */
    listModels(): Promise<Array<{
        id: string;
        displayName?: string;
        defaultReasoningEffort?: string;
    }>>;
    /** 是否已就绪（可开始对话）。 */
    ready(): Promise<boolean>;
}
