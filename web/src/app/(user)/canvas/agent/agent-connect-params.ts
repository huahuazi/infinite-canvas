import type { LocalAgentFailureCode } from "./local-agent-client";

/** 服务器托管模式下浏览器自动探测的同源端点（由 Go 后端反代到 agent 容器）。 */
export const HOSTED_AGENT_API_BASE = "/api/agent";
/** 托管模式下供 Codex / Claude 等外部 Agent 连接的同源 MCP 地址。 */
export const HOSTED_AGENT_MCP_PATH = "/api/agent/mcp";

export type AgentConnectionMode = "hosted" | "local";

/** 画布接入参数：agent 服务地址与凭据。凭据只允许来自 URL fragment。 */
export type AgentConnectParams = {
    url?: string;
    token?: string;
};

/** fragment 中是否包含接入相关键（用于判断这次刷新是否带来了新的接入请求）。 */
export function hasAgentFragment(hash: string) {
    return /(^|[#&])(agent|agentUrl|agenturl|token|agentToken|agenttoken)=/i.test(hash);
}

function normalizeKey(key: string) {
    return key.trim().toLowerCase().replace(/[_-]/g, "");
}

function safeDecode(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * 从 URL fragment 读取接入凭据：支持 #agent=<url>&token=<token> 与 #agentUrl=&agentToken= 两种写法。
 * query 参数不再作为凭据来源（会被访问日志与 Referer 记录），这里完全不读 query。
 */
export function readAgentConnectParams(): AgentConnectParams {
    const result: AgentConnectParams = {};
    const apply = (key: string, value: string) => {
        if (!value) return;
        const name = normalizeKey(key);
        if (name === "agent" || name === "agenturl") result.url = value;
        else if (name === "token" || name === "agenttoken") result.token = value;
    };

    if (typeof window !== "undefined") {
        for (const entry of window.location.hash.replace(/^#/, "").split("&")) {
            const index = entry.indexOf("=");
            if (index <= 0) continue;
            apply(entry.slice(0, index), safeDecode(entry.slice(index + 1)));
        }
    }
    return result;
}

/** 读取并立即清除地址栏 fragment，避免凭据留在地址栏、历史记录与分享链路里。 */
export function consumeAgentConnectParams() {
    const params = readAgentConnectParams();
    if (typeof window === "undefined" || !hasAgentFragment(window.location.hash)) return params;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
    return params;
}

/** 当前站点 origin（MCP 注册命令使用）。 */
export function currentOrigin() {
    return typeof window === "undefined" ? "" : window.location.origin;
}

/** 托管模式下的 MCP 地址：当前站点 origin + 同源反代路径。 */
export function withHttpTransport(origin: string) {
    return `${origin.replace(/\/+$/, "")}${HOSTED_AGENT_MCP_PATH}`;
}

export type McpCommand = { agent: string; command: string; hint?: string };

/**
 * 按部署形态生成可复制的 MCP 注册命令：托管走站点同源 http 传输，本地走仓库内可直接执行的 stdio 命令。
 * 本地命令不要求先 npm link：$(git rev-parse --show-toplevel) 在仓库内执行时会展开成仓库绝对路径。
 */
export function resolveMcpCommands(mode: AgentConnectionMode, origin = currentOrigin()): McpCommand[] {
    if (mode === "hosted") {
        const url = withHttpTransport(origin);
        return [
            { agent: "Claude Code", command: `claude mcp add infinite-canvas --transport http ${url}` },
            // Codex CLI 的 HTTP MCP 用 --url，没有 --transport 选项（claude 才是 --transport http）。
            { agent: "Codex", command: `codex mcp add infinite-canvas --url ${url}` },
        ];
    }

    const server = 'node "$(git rev-parse --show-toplevel)/agent/dist/index.js" mcp';
    const hint = "在无限画布仓库目录（含 agent/ 的那一层）里粘贴执行即可；不在仓库里时把 $(git rev-parse --show-toplevel) 换成项目绝对路径。";
    return [
        { agent: "[CC]", command: `claude mcp add infinite-canvas -- ${server}`, hint },
        { agent: "Codex", command: `codex mcp add infinite-canvas -- ${server}`, hint },
    ];
}

/** 本地模式：启动 Agent 服务的可直接执行命令（同样不依赖 npm link）。 */
export function resolveLocalAgentStartCommand() {
    return 'cd "$(git rev-parse --show-toplevel)/agent" && npm install && npm run build && node dist/index.js';
}

export type AgentFailureInfo = { title: string; detail: string; nextStep: string };

/** 连接失败原因 → 中文说明与下一步动作，避免面板只能说"连接失败"。 */
export const AGENT_FAILURE_INFO: Record<LocalAgentFailureCode, AgentFailureInfo> = {
    token_missing: {
        title: "缺少连接 token",
        detail: "已经带了服务地址，但链接里没有 token，Agent 服务会拒绝所有画布请求。",
        nextStep: "运行 infinite-canvas-agent，复制输出的 Connect token，重新打开带 #agent=<地址>&token=<token> 的画布链接；也可以直接在下方接入表单里粘贴地址与 token。",
    },
    service_offline: {
        title: "Agent 服务未启动",
        detail: "地址能访问，但没有拿到 Agent 服务响应，浏览器无法建立画布会话。",
        nextStep: "在本机终端启动 Agent 服务：cd \"$(git rev-parse --show-toplevel)/agent\" && npm install && npm run build && node dist/index.js；服务器部署则确认 agent 容器已启动。",
    },
    unauthorized: {
        title: "token 无效或已失效",
        detail: "Agent 服务在运行，但当前 token 与服务端配置不一致。",
        nextStep: "Agent 服务重启后 token 会变化：重新运行 infinite-canvas-agent，用最新输出的 Connect token 重新接入，或核对 ~/.infinite-canvas/canvas-agent.json。",
    },
    network_blocked: {
        title: "网络或跨域访问被拦截",
        detail: "浏览器的请求没能到达 Agent 服务：可能是网络不通、跨域（CORS）被拒、https 页面访问 http 服务被拦，或地址/端口填错。",
        nextStep:
            "按部署方式处理：① 服务器托管部署无需放行任何 agent 端口，浏览器走站点同源反代 /api/agent/*，请确认 agent 容器已启动、app 容器能访问它（默认 http://agent:17371），https 站点也请用这种模式；" +
            "② 本机使用请确认 infinite-canvas-agent 已启动（默认 http://127.0.0.1:17371）；" +
            "③ 只有“浏览器直连另一台机器上的 agent 端口”这种非常规用法，才需要放行该端口并允许画布站点跨域——不要为了托管模式把 17371 暴露到公网。",
    },
    protocol_mismatch: {
        title: "该地址不是可用的 Agent 服务",
        detail: "有响应但不是无限画布 Agent 服务，通常是地址填错或版本不匹配。",
        nextStep: "确认地址指向 infinite-canvas-agent（默认 http://127.0.0.1:17371）后重试，必要时升级 agent 版本。",
    },
};
