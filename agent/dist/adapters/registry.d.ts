import { type HttpAgentConfig } from "./http-agent.js";
import type { AgentAdapter } from "./types.js";
/**
 * 适配器注册表。Codex / Claude Code 为内置后端；
 * 通用 CLI 与 OpenAI 兼容端点由 HTTP 配置层按需实例化。
 */
export declare class AdapterRegistry {
    private adapters;
    private order;
    constructor();
    private register;
    /** 注册 OpenAI 兼容端点适配器（配置后调用）。 */
    addHttpAgent(id: string, config: HttpAgentConfig): boolean;
    get(id: string): AgentAdapter | undefined;
    list(): Array<{
        id: string;
        label: string;
        capabilities: string[];
    }>;
    defaultId(): string;
}
export declare const adapterRegistry: AdapterRegistry;
