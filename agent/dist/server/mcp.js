import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENT_PROMPT, loadConfig, VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
const REFRESH_INTERVAL_MS = 5_000;
/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    const server = new McpServer({ name: "infinite-canvas", version: VERSION }, { instructions: AGENT_PROMPT });
    const registered = new Set();
    /** 从本地 HTTP 服务拉取浏览器上报的画布工具，并注册新增工具。 */
    const refreshTools = async () => {
        const tools = await fetchTools(config);
        for (const tool of tools) {
            if (registered.has(tool.function.name))
                continue;
            registered.add(tool.function.name);
            const { name } = tool.function;
            server.registerTool(name, { description: tool.function.description, inputSchema: jsonSchemaToZod(tool.function.parameters) }, async (input) => {
                const result = await postCanvasTool(config, name, input);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            });
            logger.debug("Registered canvas tool", { name });
        }
    };
    await refreshTools().catch((error) => logger.warn("MCP 首次工具拉取失败", { error: error instanceof Error ? error.message : String(error) }));
    const timer = setInterval(() => void refreshTools().catch((error) => logger.warn("MCP 工具刷新失败", { error: error instanceof Error ? error.message : String(error) })), REFRESH_INTERVAL_MS);
    await server.connect(new StdioServerTransport());
    clearInterval(timer);
}
/** 拉取当前画布工具清单。 */
async function fetchTools(config) {
    const res = await fetch(`${config.url}/tools`, { headers: { "x-canvas-agent-token": config.token } });
    if (!res.ok)
        return [];
    const body = (await res.json());
    return Array.isArray(body.tools) ? body.tools : [];
}
/** 将 MCP 工具调用转发到本地 Agent HTTP 服务。 */
async function postCanvasTool(config, name, input) {
    const res = await fetch(`${config.url}/api/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: JSON.stringify({ name, input }),
    });
    const body = (await res.json());
    if (!body.ok || res.status >= 400)
        throw new Error(body.error || `tool call failed: ${res.status}`);
    return body.result;
}
/** 将浏览器上报的 JSON Schema 属性转换为 zod shape（宽松校验，只约束顶层类型）。 */
function jsonSchemaToZod(parameters) {
    const shape = {};
    const properties = parameters.properties || {};
    const required = new Set(parameters.required || []);
    for (const [key, value] of Object.entries(properties)) {
        const schema = value && typeof value === "object" ? value : {};
        let field;
        if (schema.type === "array" || Array.isArray(schema.type))
            field = z.array(z.unknown());
        else if (schema.type === "boolean")
            field = z.boolean();
        else if (schema.type === "number" || schema.type === "integer")
            field = z.number();
        else
            field = z.string();
        shape[key] = required.has(key) ? field : field.optional();
    }
    return shape;
}
