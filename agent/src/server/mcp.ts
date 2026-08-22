import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AGENT_PROMPT, loadConfig, VERSION, type CanvasAgentConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } } };

const REFRESH_INTERVAL_MS = 5_000;

/** 共享画布工具注册表：定期从 HTTP 服务拉取浏览器上报的工具，供所有 MCP 连接共用。 */
class ToolRegistry {
    private tools: ToolSpec[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;

    list(): ToolSpec[] {
        return this.tools;
    }

    /** 启动周期性刷新（HTTP 服务进程内调用）。 */
    start(config: CanvasAgentConfig) {
        if (this.timer) return;
        this.timer = setInterval(() => void this.refresh(config).catch(() => undefined), REFRESH_INTERVAL_MS);
        void this.refresh(config).catch(() => undefined);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async refresh(config: CanvasAgentConfig) {
        const res = await fetch(`${config.url}/tools`, { headers: { "x-canvas-agent-token": config.token } });
        if (!res.ok) return;
        const body = (await res.json()) as { ok?: boolean; tools?: ToolSpec[] };
        if (Array.isArray(body.tools)) this.tools = body.tools;
    }
}

export const toolRegistry = new ToolRegistry();

/** 为单个连接创建 MCP Server（SDK 每个 Protocol 只支持一个 transport，连接各自实例）。 */
export function createMcpServer(config: CanvasAgentConfig) {
    const server = new McpServer({ name: "infinite-canvas", version: VERSION }, { instructions: AGENT_PROMPT });
    /** 占位工具：保证 tools/ handlers 总在（否则无画布连接时 tools/list 报 Method not found）。 */
    server.registerTool("ping", { description: "检查画布 Agent 服务连通性，始终可用。", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: '{"ok":true}' }] }));
    for (const tool of toolRegistry.list()) {
        const { name } = tool.function;
        server.registerTool(name, { description: tool.function.description, inputSchema: jsonSchemaToZod(tool.function.parameters) }, async (input: unknown) => {
            const result = await postCanvasTool(config, name, input);
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        });
        logger.debug("Registered canvas tool", { name });
    }
    return server;
}

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    await toolRegistry.refresh(config);
    const server = createMcpServer(config);
    await server.connect(new StdioServerTransport());
}

/** 将 MCP 工具调用转发到本地 Agent HTTP 服务。 */
export async function postCanvasTool(config: CanvasAgentConfig, name: string, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: JSON.stringify({ name, input }),
    });
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (!body.ok || res.status >= 400) throw new Error(body.error || `tool call failed: ${res.status}`);
    return body.result;
}

/** 将浏览器上报的 JSON Schema 属性转换为 zod shape（宽松校验，只约束顶层类型）。 */
function jsonSchemaToZod(parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] }): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const properties = parameters.properties || {};
    const required = new Set(parameters.required || []);
    for (const [key, value] of Object.entries(properties)) {
        const schema = value && typeof value === "object" ? (value as { type?: string; items?: unknown }) : {};
        let field: z.ZodTypeAny;
        if (schema.type === "array" || Array.isArray(schema.type)) field = z.array(z.unknown());
        else if (schema.type === "boolean") field = z.boolean();
        else if (schema.type === "number" || schema.type === "integer") field = z.number();
        else field = z.string();
        shape[key] = required.has(key) ? field : field.optional();
    }
    return shape;
}