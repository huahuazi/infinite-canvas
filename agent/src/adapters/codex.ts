import { CodexAppClient } from "../codex/codex-client.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import { logger } from "../utils/logger.js";
import { errorMessage, field } from "../utils/value.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";

/** 将 app-server 返回的线程对象压缩为摘要。 */
function summarizeThread(thread: unknown): ThreadBrief {
    return {
        id: String(field(thread, "id") || ""),
        preview: String(field(thread, "preview") || ""),
        name: field(thread, "name") == null ? null : String(field(thread, "name")),
        cwd: String(field(thread, "cwd") || ""),
        status: typeof field(thread, "status") === "string" ? String(field(thread, "status")) : String(field(field(thread, "status"), "type") || ""),
        updatedAt: Number(field(thread, "updatedAt") || 0),
    };
}

/**
 * Codex 适配器：spawn `codex app-server --stdio`，走完整 JSON-RPC 协议。
 * 支持线程、审批、流式、模型列表；Codex turn 会自举画布 MCP。
 */
export class CodexAdapter implements AgentAdapter {
    readonly id = "codex";
    readonly label = "Codex";
    readonly capabilities = ["threads", "approvals", "streaming", "skills", "models"] as const;

    private clientPromise: Promise<CodexAppClient> | null = null;
    private emitRef: AgentEmit = () => undefined;

    async start(emit: AgentEmit) {
        this.emitRef = emit;
        await this.getClient(emit);
    }

    private getClient(emit: AgentEmit): Promise<CodexAppClient> {
        if (this.clientPromise) return this.clientPromise;
        this.clientPromise = CodexAppClient.start(emit, () => {
            this.clientPromise = null;
        }).catch((error) => {
            this.clientPromise = null;
            throw error;
        });
        return this.clientPromise;
    }

    async startThread(cwd?: string, permissionMode: AgentPermissionMode = "request") {
        const client = await this.getClient(this.emitRef);
        const thread = await client.startThread(cwd, permissionMode);
        return summarizeThread(thread);
    }

    async resumeThread(threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request") {
        const client = await this.getClient(this.emitRef);
        const thread = await client.resumeThread(threadId, cwd, permissionMode);
        return summarizeThread(thread);
    }

    async listThreads(opts: { cwd: string; searchTerm?: string; limit?: number }) {
        const client = await this.getClient(this.emitRef);
        const result = await client.listThreads({
            limit: opts.limit || 40,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: ["cli", "vscode", "appServer", "exec"],
            cwd: opts.cwd,
            ...(opts.searchTerm ? { searchTerm: opts.searchTerm } : {}),
        });
        const data = Array.isArray(field(result, "data")) ? (field(result, "data") as unknown[]).map(summarizeThread) : [];
        return { data };
    }

    async archiveThread(threadId: string) {
        const client = await this.getClient(this.emitRef);
        await client.archiveThread(threadId);
    }

    async runTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: TurnOptions) {
        const client = await this.getClient(emit);
        const threadId = options.threadId || "";
        if (!threadId) throw new Error("Codex 需要先创建或恢复线程");
        const images = attachments.filter((item) => item.dataUrl).map((item) => item.dataUrl!);
        options.onStart?.();
        try {
            await client.startTurn(threadId, prompt, images, options.permissionMode || "request", options.model, undefined, (turnId) => options.onTurn?.(turnId));
            options.onFinish?.();
        } catch (error) {
            logger.warn("Codex turn failed", { error: errorMessage(error) });
            options.onFinish?.();
            throw error;
        }
    }

    async interrupt(threadId?: string) {
        const client = await this.getClient(this.emitRef);
        return client.interruptCurrentTurn(threadId);
    }

    async resolveApproval(requestId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
        const client = await this.getClient(this.emitRef);
        return client.resolveApproval(requestId, decision);
    }

    async listModels() {
        const client = await this.getClient(this.emitRef);
        const result = await client.listModels();
        const data = Array.isArray(result) ? result : Array.isArray(field(result, "data")) ? (field(result, "data") as unknown[]) : [];
        return data.map((item) => ({
            id: String(field(item, "id") || field(item, "model") || ""),
            displayName: String(field(item, "displayName") || field(item, "model") || ""),
            defaultReasoningEffort: String(field(item, "defaultReasoningEffort") || ""),
        }));
    }

    async ready() {
        return true;
    }
}