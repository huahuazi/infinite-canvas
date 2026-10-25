import { logger } from "../utils/logger.js";

/** 无头画布通道配置：agent 容器直接调后端，不经过浏览器。 */
export type HeadlessConfig = { apiBase: string; apiKey: string; userId: string };

/** 与 MCP 工具定义同构的 schema（避免与 mcp.ts 形成运行时循环依赖）。 */
export type HeadlessToolSpec = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    };
};

const REQUEST_TIMEOUT_MS = 60_000;
const STRING = { type: "string" } as const;
const STRING_ARRAY = { type: "array", items: { type: "string" } } as const;

/**
 * 无头工具：不依赖浏览器，直接读写画布数据。
 * 适合页面关着的时候做批量整理 / 批量出图，或把画布接进 CI。
 */
export const HEADLESS_TOOLS: HeadlessToolSpec[] = [
    {
        type: "function",
        function: {
            name: "headless_list_projects",
            description: "【无需浏览器】列出当前用户的全部画布（id / 标题 / 节点数 / 更新时间）。",
            parameters: { type: "object", properties: {}, additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "headless_read_graph",
            description: "【无需浏览器】读取指定画布的节点与连线。长文本字段会被截断到 240 字，图片 Base64 不会返回。",
            parameters: { type: "object", properties: { projectId: STRING }, required: ["projectId"], additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "headless_apply_ops",
            description:
                "【无需浏览器】批量修改画布并立即落库。支持 op：add_node / update_node / remove_node / add_connection / remove_connection。" +
                "add_node 需要 node（type/title/position/metadata）；update_node 需要 nodeId 与 patch（metadata 会浅合并）；" +
                "add_connection 需要 fromNodeId 与 toNodeId；remove_* 需要 nodeId 或 connectionId。",
            parameters: {
                type: "object",
                properties: { projectId: STRING, ops: { type: "array", items: { type: "object" } } },
                required: ["projectId", "ops"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "headless_generate_image",
            description:
                "【无需浏览器】直接用服务端渠道发起图片生成，返回 taskId。任务异步执行，用 headless_task_status 查询；" +
                "拿到 imageUrl 后可再用 headless_apply_ops 写回节点 metadata.content。",
            parameters: {
                type: "object",
                properties: {
                    projectId: STRING,
                    prompt: STRING,
                    model: STRING,
                    nodeId: STRING,
                    channelId: STRING,
                    size: STRING,
                    quality: STRING,
                    count: { type: "number" },
                    requestBody: { type: "object" },
                },
                required: ["projectId", "prompt", "model"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "headless_task_status",
            description: "【无需浏览器】查询图片或音频生成任务的状态与产物地址。",
            parameters: { type: "object", properties: { taskId: STRING }, required: ["taskId"], additionalProperties: false },
        },
    },
];

/** 从环境变量解析无头通道配置；缺少任一项则视为未启用。 */
export function resolveHeadlessConfig(userId?: string): HeadlessConfig | null {
    const apiBase = (process.env.CANVAS_API_BASE || "").trim();
    const apiKey = (process.env.AGENT_MCP_KEY || process.env.AGENT_TOKEN || "").trim();
    const targetUser = (userId || process.env.CANVAS_USER_ID || "").trim();
    if (!apiBase || !apiKey || !targetUser) return null;
    return { apiBase, apiKey, userId: targetUser };
}

/** 执行无头工具，返回后端 data 原样结构。 */
export async function callHeadlessTool(name: string, input: unknown, config: HeadlessConfig): Promise<unknown> {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
        const url = `${config.apiBase.replace(/\/+$/, "")}${path}`;
        const response = await fetch(url, {
            method,
            headers: { "content-type": "application/json", "x-agent-key": config.apiKey, "x-user-id": config.userId },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const payload = (await response.json().catch(() => ({}))) as { code?: number; data?: unknown; msg?: string };
        if (!response.ok) throw new Error(payload.msg || `后端请求失败：${response.status}`);
        if (payload.code !== 0) throw new Error(payload.msg || "后端返回失败");
        return payload.data;
    };

    const projectPath = (projectId: unknown) => `/api/agent-canvas/projects/${encodeURIComponent(String(projectId || ""))}`;

    switch (name) {
        case "headless_list_projects":
            return request("GET", "/api/agent-canvas/projects");
        case "headless_read_graph":
            return request("GET", `${projectPath(args.projectId)}/graph`);
        case "headless_apply_ops":
            return request("POST", `${projectPath(args.projectId)}/ops`, { ops: args.ops || [] });
        case "headless_generate_image":
            return request("POST", `${projectPath(args.projectId)}/generate`, {
                prompt: args.prompt,
                model: args.model,
                nodeId: args.nodeId,
                channelId: args.channelId,
                size: args.size,
                quality: args.quality,
                count: args.count,
                requestBody: args.requestBody,
            });
        case "headless_task_status":
            return request("GET", `/api/agent-canvas/tasks/${encodeURIComponent(String(args.taskId || ""))}`);
        default:
            throw new Error(`未知的无头工具：${name}`);
    }
}

/** 无头通道未配置时，给出一条能自我解释的提示（而不是静默少注册几个工具）。 */
export function headlessDisabledHint() {
    const hint = "无头画布通道未启用：需要 CANVAS_API_BASE（如 http://app:3000）、AGENT_MCP_KEY（或 AGENT_TOKEN）与 userId（MCP 地址 ?userId= 或 CANVAS_USER_ID）。";
    logger.debug(hint);
    return hint;
}
