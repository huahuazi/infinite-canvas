import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PROMPT, CONFIG_DIR } from "../config.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../codex/types.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
import type { AgentAdapter, ThreadBrief, TurnOptions } from "./types.js";

const SESSION_DIR = path.join(CONFIG_DIR, "claude-sessions");

/**
 * Claude Code 适配器：spawn `claude -p --output-format stream-json`。
 * 通过会话文件实现简单持久化（Claude CLI 无线程 API，用 --resume 恢复会话）。
 */
export class ClaudeCodeAdapter implements AgentAdapter {
    readonly id = "claude-code";
    readonly label = "Claude Code";
    readonly capabilities = ["streaming"] as const;

    private child: ChildProcess | null = null;

    private sessionRecord(sessionId: string): { id: string; preview: string; updatedAt: number } | null {
        try {
            const value = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${sessionId}.json`), "utf8")) as { id: string; preview: string; updatedAt: number };
            return value;
        } catch {
            return null;
        }
    }

    async start() {
        logger.info("Claude Code adapter ready");
    }

    async startThread(cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief> {
        const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { id, preview: "", name: "新会话", cwd };
    }

    async resumeThread(threadId: string, cwd?: string, _permissionMode?: AgentPermissionMode): Promise<ThreadBrief> {
        const session = this.sessionRecord(threadId);
        if (!session) throw new Error(`找不到 Claude 会话 ${threadId}`);
        return { id: threadId, preview: session.preview, name: null, cwd };
    }

    async listThreads(opts: { cwd: string; searchTerm?: string; limit?: number }) {
        const files = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR).filter((name) => name.endsWith(".json")) : [];
        const sessions = files.map((name) => this.sessionRecord(name.replace(/\.json$/, ""))).filter(Boolean).sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
        const filtered = sessions.filter((item) => item && (!opts.searchTerm || item.preview.includes(opts.searchTerm))).slice(0, opts.limit || 40);
        return { data: filtered.map((item) => ({ id: item!.id, preview: item!.preview, name: null as string | null, updatedAt: item!.updatedAt })) };
    }

    async archiveThread(threadId: string) {
        await fs.promises.unlink(path.join(SESSION_DIR, `${threadId}.json`)).catch(() => undefined);
    }

    runTurn(prompt: string, emit: AgentEmit, _attachments: AgentAttachment[], options: TurnOptions) {
        return new Promise<void>((resolve) => {
            if (!prompt.trim()) return resolve();
            const sessionId = options.threadId || "";
            const resume = sessionId ? this.sessionRecord(sessionId) : null;
            const args = [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--allowedTools",
                "mcp__infinite-canvas__*",
                ...(resume ? ["--resume", sessionId] : []),
                `${AGENT_PROMPT}\n\n用户请求：${prompt}`,
            ];
            options.onStart?.();
            try {
                const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
                this.child = child;
                options.onTurn?.(sessionId || "");
                let output = "";
                let buffer = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    buffer += chunk.toString();
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const event = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
                            if (event.type === "stream_event" && event.message?.content) {
                                for (const part of event.message.content) {
                                    if (part.type === "text" && part.text) {
                                        output += part.text;
                                        emit("agent_delta", { agent: "claude", text: part.text });
                                    }
                                }
                            }
                        } catch {
                            // 忽略无法解析的行
                        }
                    }
                });
                child.stderr?.on("data", (chunk: Buffer) => emit("agent_log", { text: chunk.toString() }));
                child.on("error", (error) => emit("agent_error", { message: error.message }));
                child.on("close", () => {
                    fs.mkdirSync(SESSION_DIR, { recursive: true });
                    if (sessionId && output.trim()) {
                        fs.writeFileSync(path.join(SESSION_DIR, `${sessionId}.json`), JSON.stringify({ id: sessionId, preview: output.trim().slice(0, 120), updatedAt: Date.now() }));
                    }
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