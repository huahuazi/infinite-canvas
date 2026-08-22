import { AGENT_PROMPT } from "../config.js";
import { canvasSession } from "../canvas/session.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
/**
 * OpenAI 兼容端点适配器：把画布状态与工具说明压缩进 system prompt，
 * 调用远端 /chat/completions。模型回复（支持 JSON actions）由浏览器端解析执行。
 */
export class HttpAgentAdapter {
    config;
    id = "http-agent";
    label = "OpenAI 兼容端点";
    capabilities = ["streaming"];
    constructor(config) {
        this.config = config;
    }
    async start() {
        logger.info("Http agent adapter ready", { model: this.config.model });
    }
    async startThread(cwd) {
        const id = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { id, preview: "", name: "新会话", cwd };
    }
    async resumeThread(threadId, cwd) {
        return { id: threadId, preview: "", name: null, cwd };
    }
    async listThreads() {
        return { data: [] };
    }
    async archiveThread() {
        // 无持久化
    }
    async runTurn(prompt, emit, _attachments, options) {
        options.onStart?.();
        options.onTurn?.(options.threadId || "");
        const snapshot = canvasSession.canvasSnapshot();
        const tools = canvasSession.toolDefinitions();
        const system = [
            AGENT_PROMPT,
            "当前画布状态：",
            JSON.stringify(snapshot).slice(0, 20_000),
            "可用工具（JSON actions，name + arguments）：",
            JSON.stringify(tools.map((tool) => tool.function)).slice(0, 20_000),
        ].join("\n\n");
        try {
            const { pathname, search } = new URL(this.config.baseUrl);
            const endpoint = pathname.endsWith("/chat/completions") ? this.config.baseUrl : `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
            const res = await fetch(`${endpoint}${search}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.config.model,
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: prompt },
                    ],
                    stream: false,
                }),
                signal: AbortSignal.timeout(180_000),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
            const body = (await res.json());
            const content = body.choices?.[0]?.message?.content || "";
            emit("agent_delta", { agent: "http", text: content });
            options.onFinish?.();
        }
        catch (error) {
            emit("agent_error", { message: errorMessage(error) });
            options.onFinish?.();
            throw error;
        }
    }
    async interrupt() {
        return false;
    }
    async resolveApproval() {
        return false;
    }
    async listModels() {
        return [{ id: this.config.model, displayName: this.config.model }];
    }
    async ready() {
        return true;
    }
}
