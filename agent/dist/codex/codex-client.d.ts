import { type JsonRecord } from "../utils/value.js";
import type { CodexPlanUpdate, CodexReasoningEffort, CodexRequestParams, CodexSkillSelector } from "./codex-protocol.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";
/** 表示错误已经通过 app-server 终态或进程事件通知过网页。 */
export declare class CodexReportedError extends Error {
    name: string;
}
/** 封装 Codex app-server 的 JSON-RPC 通信与事件转换。 */
export declare class CodexAppClient {
    private child;
    private emit;
    private eventHistory;
    private nextId;
    private buffer;
    private currentThreadId;
    private currentTurnId;
    private pendingTurnStart?;
    private startedTurnKeys;
    private textByItem;
    private reasoningTextByItem;
    private lastUsage;
    private pending;
    private activeTurns;
    private completedTurns;
    private completedTurnResults;
    private pendingDeltas;
    private startedItems;
    private itemSequences;
    private nextItemSequences;
    private plansByTurn;
    private approvalRequests;
    private finalizingTurns;
    private skillReloads;
    private silentThreadIds;
    private structuredOutputByTurn;
    private pendingSilentThreadStarts;
    private pendingThreadStartedNotifications;
    private pendingPreheatThreadStarts;
    private preheatingThreadIds;
    private failing;
    private failureMessage;
    /** 保存 app-server 子进程和事件出口。 */
    private constructor();
    /** 启动并初始化 Codex app-server。 */
    static start(emit: AgentEmit, onExit: () => void): Promise<CodexAppClient>;
    /** 创建新的 Codex 线程。 */
    startThread(cwd?: string, permissionMode?: AgentPermissionMode, preheat?: boolean): Promise<import("./codex-protocol.js").CodexThread>;
    /** 创建不会持久化或向网页广播的草稿线程。 */
    startSkillDraftThread(cwd: string): Promise<import("./codex-protocol.js").CodexThread>;
    /** 从指定对话派生不会持久化或向网页广播的草稿线程。 */
    forkSkillDraftThread(threadId: string, cwd: string): Promise<import("./codex-protocol.js").CodexThread>;
    /** 恢复已有 Codex 线程。 */
    resumeThread(threadId: string, cwd?: string, permissionMode?: AgentPermissionMode, preheat?: boolean): Promise<import("./codex-protocol.js").CodexThread>;
    /** 以 app-server 的权威 MCP 清单响应作为预热完成边界。 */
    private completeMcpPreheat;
    /** 查询 Codex 线程列表。 */
    listThreads(params: CodexRequestParams<"thread/list">): Promise<{
        data: import("./codex-protocol.js").CodexThread[];
        nextCursor: string | null;
        backwardsCursor: string | null;
    }>;
    /** 读取指定 Codex 线程。 */
    readThread(threadId: string, includeTurns?: boolean): Promise<{
        thread: import("./codex-protocol.js").CodexThread;
    }>;
    /** 归档指定 Codex 线程。 */
    archiveThread(threadId: string): Promise<Record<string, never>>;
    /** 释放临时草稿线程的 App Server 订阅和进程内缓存。 */
    closeSkillDraftThread(threadId: string): Promise<void>;
    /** 查询当前账号可用的 Codex 模型。 */
    listModels(): Promise<{
        data: import("./codex-protocol.js").CodexModel[];
        nextCursor: string | null;
    }>;
    /** 查询指定工作空间可发现的 Codex Skills。 */
    listSkills(cwd: string, forceReload?: boolean): Promise<{
        data: import("./codex-protocol.js").CodexSkillsListEntry[];
    }>;
    /** 修改一个已发现 Skill 的启用状态。 */
    setSkillEnabled(path: string, enabled: boolean): Promise<{
        effectiveEnabled: boolean;
    }>;
    /** 返回指定线程在当前进程中收到的最新任务计划。 */
    planUpdates(threadId: string): CodexPlanUpdate[];
    /** 清理已归档线程的任务计划缓存。 */
    clearPlanUpdates(threadId: string): void;
    /** 启动一个 Codex turn 并等待完成通知。 */
    startTurn(threadId: string, prompt: string, images: string[], permissionMode: AgentPermissionMode, model?: string, effort?: CodexReasoningEffort, onTurn?: (turnId: string) => void, skill?: CodexSkillSelector, messageText?: string, outputSchema?: JsonRecord): Promise<unknown>;
    /** 在静默线程中生成结构化输出。 */
    generateSkillDraft(threadId: string, prompt: string, outputSchema: JsonRecord, model?: string, effort?: CodexReasoningEffort): Promise<string>;
    /** 中断当前正在运行且属于指定线程的 Codex turn。 */
    interruptCurrentTurn(requestedThreadId?: string): Promise<boolean>;
    /** 回复网页端已经确认的 Codex 权限请求。 */
    resolveApproval(requestId: string, decision: string): boolean;
    /** 标记下一次临时线程创建，使早于请求响应到达的通知也不会外泄。 */
    private startSilentThread;
    /** 发送 JSON-RPC 请求并保存待处理 Promise。 */
    private request;
    /** 发送无需响应的 JSON-RPC 通知。 */
    private notify;
    /** 将 JSON-RPC 消息写入 app-server 标准输入。 */
    private write;
    /** 按行解析 app-server 标准输出。 */
    private read;
    /** 分派单条 JSON-RPC 响应、请求或通知。 */
    private handle;
    /** 转换并广播 app-server 通知。 */
    private handleNotification;
    /** 草稿线程存续期间隐藏 app-server 自身输出，避免混入网页诊断日志。 */
    private get skillDraftActive();
    /** 消化临时草稿线程事件，不广播、不落补充历史。 */
    private handleSilentNotification;
    /** 请求响应确定静默线程 ID 后，重新分流早到的启动通知。 */
    private flushPendingThreadStartedNotifications;
    /** 补充历史落盘后再广播 turn 终态，确保界面完成状态可跨 Agent 重启恢复。 */
    private completeTurn;
    /** 合并并广播 Agent 文本或执行输出增量。 */
    private emitDelta;
    /** 合并短时间内的文本增量，减少 SSE 传输和前端渲染次数。 */
    private flushDelta;
    /** 按 Codex summaryIndex 保存 reasoning 分段，顺序与线程历史一致。 */
    private appendReasoningText;
    /** turn 结束时发送最后一批增量并清理未收到 item.completed 的缓存。 */
    private finishTurnDeltas;
    /** 为一个 turn 内的 item 固定开始顺序，完成通知只更新内容。 */
    private assignItemSequence;
    /** 在通知或 turn/start 响应到达时回调一次 turn 启动状态。 */
    private notifyTurnStarted;
    /** 自动回复 app-server 发起的授权或交互请求。 */
    private answerServerRequest;
    /** 完成指定 JSON-RPC 请求。 */
    private resolve;
    /** 拒绝指定 JSON-RPC 请求。 */
    private reject;
    /** 拒绝进程退出时仍未完成的请求与 turn。 */
    private failAll;
}
/** 合并单个 reasoning 分段增量并按 summaryIndex 输出。 */
export declare function appendReasoningDelta(segments: Map<number, string>, summaryIndex: number | undefined, delta: string): string;
