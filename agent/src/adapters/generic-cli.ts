import { spawn, type ChildProcess } from "node:child_process";

import { AGENT_PROMPT } from "../config.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
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
export class GenericCliAdapter implements AgentAdapter {
    readonly id = "generic-cli";
    readonly label = "通用 CLI Agent";
    readonly capabilities = [] as const;

    private child: ChildProcess | null = null;

    constructor(private config: GenericCliConfig) {}

    async start() {
        logger.info("Generic CLI adapter ready", { command: this.config.command });
    }

    async startThread(cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief> {
        const id = `generic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { id, preview: "", name: "新会话", cwd };
    }

    async resumeThread(threadId: string, cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief> {
        return { id: threadId, preview: "", name: null, cwd };
    }

    async listThreads() {
        return { data: [] };
    }

    async archiveThread() {
        // 通用 CLI 无线程持久化
    }

    runTurn(prompt: string, emit: AgentEmit, _attachments: AgentAttachment[], options: TurnOptions) {
        return new Promise<void>((resolve) => {
            if (!prompt.trim()) return resolve();
            const args = [...(this.config.args?.length ? this.config.args : ["-p"]), prompt];
            options.onStart?.();
            try {
                const child = spawn(this.config.command, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
                this.child = child;
                options.onTurn?.(options.threadId || "");
                let output = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    const text = chunk.toString();
                    output += text;
                    emit("agent_delta", { agent: this.config.command, text });
                });
                child.stderr?.on("data", (chunk: Buffer) => emit("agent_log", { text: chunk.toString() }));
                child.on("error", (error) => emit("agent_error", { message: error.message }));
                child.on("close", () => {
                    this.child = null;
                    options.onFinish?.();
                    resolve();
                });
            } catch (error) {
                emit("agent_error", { message: errorMessage(error) });
                options.onFinish?.();
                resolve();
            }
        });
    }

    async interrupt() {
        if (this.child && !this.child.killed) {
            this.child.kill("SIGTERM");
            return true;
        }
        return false;
    }

    async resolveApproval() {
        return false;
    }

    async listModels() {
        return [];
    }

    async ready() {
        return true;
    }
}

/** 默认通用 CLI 配置（供 registry 使用）。 */
export function defaultGenericCliConfig(): Record<string, GenericCliConfig> {
    return {
        gemini: { command: "gemini", args: ["-p"], allowedTools: ["mcp__infinite-canvas__*"] },
        opencode: { command: "opencode", args: ["run"], allowedTools: [] },
    };
}