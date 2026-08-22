import express, { type NextFunction, type Request, type Response } from "express";

import { adapterRegistry } from "../adapters/registry.js";
import { canvasSession } from "../canvas/session.js";
import { DEFAULT_PORT, loadConfig, saveConfig, VERSION, type CanvasAgentConfig } from "../config.js";
import type { AgentEmit, AgentPermissionMode } from "../codex/types.js";
import { logger } from "../utils/logger.js";

const PROTOCOL_VERSION = "3";

/** 启动仅监听本机的 Agent HTTP 服务。 */
export function startHttpServer() {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);

    /** 首个 SSE 连接的 clientId 作为后续画布请求的默认回退，保证浏览器完整闭环。 */
    let sseClientId = "";
    /** 解析请求归属的客户端；未显式指定时回退到首连 SSE 客户端。 */
    const requestClientId = (req: Request) => String(req.query.clientId || req.body?.clientId || sseClientId || "default");

    /** 将 Agent 事件广播到全部已连接网页。 */
    const emit: AgentEmit = (type, payload) => canvasSession.broadcast(type, payload);

    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "30mb" }));
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        res.setHeader("Access-Control-Allow-Origin", origin || "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        if (!origin || req.method === "OPTIONS" || req.path === "/health" || req.path === "/config") return next();
        config.origins ||= [];
        if (validToken(req, config.token) && !config.origins.includes(origin)) {
            config.origins.push(origin);
            saveConfig(config);
        }
        res.setHeader("Vary", "Origin");
        if (!config.origins.includes(origin)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        next();
    });
    app.use((req, res, next) => {
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });

    app.get("/health", (_req, res) => res.json({ ...canvasSession.health(), version: VERSION }));
    app.get("/config", (_req, res) => res.json({ ok: true, protocolVersion: PROTOCOL_VERSION, url: config.url, hasToken: true, adapters: adapterRegistry.list(), defaultAdapter: adapterRegistry.defaultId() }));

    app.use((req, res, next) => {
        if (validToken(req, config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });

    // ---- 浏览器连接 ----
    app.get("/events", (req, res) => {
        const id = requestClientId(req);
        if (!sseClientId) sseClientId = id;
        canvasSession.openEvents(id, res);
    });
    app.post("/canvas/state", (req, res) => {
        canvasSession.updateState(requestClientId(req), req.body || {});
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        const active = canvasSession.activateClient(requestClientId(req));
        res.json({ ok: true, activeClientId: active });
    });
    app.post("/canvas/result", (req, res) => {
        const ok = canvasSession.resolveResult(requestClientId(req), req.body || {});
        res.status(ok ? 200 : 409).json({ ok });
    });

    // ---- 画布工具（MCP 子进程与外部调用共用） ----
    app.get("/tools", (_req, res) => {
        res.json({ ok: true, tools: canvasSession.toolDefinitions() });
    });
    app.post("/api/tools", route(async (req, res) => {
        const name = String(req.body?.name || "");
        const input = req.body?.input && typeof req.body.input === "object" ? req.body.input : {};
        if (!name) return res.status(400).json({ ok: false, error: "工具名称不能为空" });
        const result = await canvasSession.callTool(name, input);
        res.json({ ok: true, result });
    }));

    // ---- Agent 对话 ----
    app.post("/agent/turn", route(async (req, res) => {
        requireClient(req);
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const threadId = String(req.body?.threadId || "");
        if (!threadId) return res.status(409).json({ ok: false, error: "请先创建会话线程" });
        void adapter.runTurn(prompt, emit, [], {
            threadId,
            cwd: String(req.body?.cwd || ""),
            permissionMode: permissionMode(req.body?.permissionMode),
            model: String(req.body?.model || "") || undefined,
            messageText: String(req.body?.messageText || prompt),
        }).catch((error) => {
            logger.warn("Agent turn failed", { error: error instanceof Error ? error.message : String(error) });
            emit("agent_error", { message: error instanceof Error ? error.message : String(error) });
        });
        res.json({ ok: true, threadId });
    }));
    app.post("/agent/interrupt", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        const ok = await adapter.interrupt(String(req.body?.threadId || "") || undefined);
        res.status(ok ? 200 : 409).json({ ok });
    }));
    app.post("/agent/approval", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const ok = await adapter.resolveApproval(String(req.body?.requestId || ""), decision as "accept" | "acceptForSession" | "decline" | "cancel");
        res.status(ok ? 200 : 409).json({ ok });
    }));
    app.get("/agent/threads", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.query.adapter || ""));
        const data = await adapter.listThreads({ cwd: String(req.query.cwd || ""), searchTerm: String(req.query.searchTerm || "") || undefined, limit: 40 });
        res.json({ ok: true, ...data });
    }));
    app.post("/agent/threads/new", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        const thread = await adapter.startThread(String(req.body?.cwd || ""), permissionMode(req.body?.permissionMode));
        res.json({ ok: true, thread });
    }));
    app.post("/agent/threads/:threadId/resume", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        const thread = await adapter.resumeThread(String(req.params.threadId), String(req.body?.cwd || ""), permissionMode(req.body?.permissionMode));
        res.json({ ok: true, thread });
    }));
    app.post("/agent/threads/:threadId/delete", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.body?.adapter || ""));
        await adapter.archiveThread(String(req.params.threadId));
        res.json({ ok: true });
    }));
    app.get("/agent/models", route(async (req, res) => {
        const adapter = resolveAdapter(String(req.query.adapter || ""));
        res.json({ ok: true, models: await adapter.listModels() });
    }));

    // ---- 管控 ----
    app.post("/agent/adapters", route(async (req, res) => {
        const id = String(req.body?.id || "");
        const baseUrl = String(req.body?.baseUrl || "");
        const model = String(req.body?.model || "");
        if (!id || !baseUrl || !model) return res.status(400).json({ ok: false, error: "id/baseUrl/model 不能为空" });
        if (adapterRegistry.addHttpAgent(id, { baseUrl, model, apiKey: String(req.body?.apiKey || "") || undefined })) return res.status(201).json({ ok: true, adapters: adapterRegistry.list() });
        res.status(409).json({ ok: false, error: `适配器 ${id} 已存在` });
    }));

    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { error: error.message });
        res.status(500).json({ ok: false, error: error.message });
    });

    app.listen(port, "127.0.0.1", () => {
        console.log("Infinite Canvas Agent");
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log(`Default adapter: ${adapterRegistry.defaultId()}`);
        console.log("MCP 模式使用: npx -y @huahuazi/infinite-canvas-agent mcp");
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
    });
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return req.query.token === token || header === token || (Array.isArray(header) && header.includes(token));
}

/** 解析适配器，未知时回退默认。 */
function resolveAdapter(id: string) {
    return adapterRegistry.get(id) || adapterRegistry.get(adapterRegistry.defaultId())!;
}

/** 对话类请求必须来自已连接浏览器。 */
function requireClient(req: Request) {
    const id = String(req.body?.clientId || "");
    if (id && !canvasSession.hasCanvas()) throw new Error("当前没有已连接画布，请先在浏览器打开画布并连接本地 Agent");
}

function permissionMode(value: unknown): AgentPermissionMode {
    return value === "automatic" || value === "full" ? value : "request";
}