import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";
export type GenericCliConfig = {
    /** CLI 可执行文件，如 gemini、opencode、qwen-code。 */
    command: string;
    /** print 模式参数前缀，如 ["-p"]。 */
    args?: string[];
    /** 允许该 CLI 使用的画布 MCP 工具前缀，如 mcp__infinite-canvas__*。 */
    allowedTools?: string[];
};
/**
 * 通用 CLI 适配器：适配任何支持 print 模式（-p + prompt）的 Agent CLI。
 * 把画布指令写入 AGENTS.md，Agent 通过 MCP 工具操作画布。
 */
export declare class GenericCliAdapter implements AgentAdapter {
    private config;
    readonly id = "generic-cli";
    readonly label = "\u901A\u7528 CLI Agent";
    readonly capabilities: readonly [];
    private child;
    constructor(config: GenericCliConfig);
    start(): Promise<void>;
    startThread(cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    resumeThread(threadId: string, cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief>;
    listThreads(): Promise<{
        data: never[];
    }>;
    archiveThread(): Promise<void>;
    runTurn(prompt: string, emit: AgentEmit, _attachments: AgentAttachment[], options: TurnOptions): Promise<void>;
    interrupt(): Promise<boolean>;
    resolveApproval(): Promise<boolean>;
    listModels(): Promise<never[]>;
    ready(): Promise<boolean>;
}
/** 默认通用 CLI 配置（供 registry 使用）。 */
export declare function defaultGenericCliConfig(): Record<string, GenericCliConfig>;
