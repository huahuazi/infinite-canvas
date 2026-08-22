import type { AgentAttachment, AgentEmit } from "../codex/types.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";
export type HttpAgentConfig = {
    baseUrl: string;
    apiKey?: string;
    model: string;
};
/**
 * OpenAI 兼容端点适配器：把画布状态与工具说明压缩进 system prompt，
 * 调用远端 /chat/completions。模型回复（支持 JSON actions）由浏览器端解析执行。
 */
export declare class HttpAgentAdapter implements AgentAdapter {
    private config;
    readonly id = "http-agent";
    readonly label = "OpenAI \u517C\u5BB9\u7AEF\u70B9";
    readonly capabilities: readonly ["streaming"];
    constructor(config: HttpAgentConfig);
    start(): Promise<void>;
    startThread(cwd?: string): Promise<ThreadBrief>;
    resumeThread(threadId: string, cwd?: string): Promise<ThreadBrief>;
    listThreads(): Promise<{
        data: never[];
    }>;
    archiveThread(): Promise<void>;
    runTurn(prompt: string, emit: AgentEmit, _attachments: AgentAttachment[], options: TurnOptions): Promise<void>;
    interrupt(): Promise<boolean>;
    resolveApproval(): Promise<boolean>;
    listModels(): Promise<{
        id: string;
        displayName: string;
    }[]>;
    ready(): Promise<boolean>;
}
