// agent 服务冒烟验证：health + config + token 守卫 + 浏览器工具转发闭环 + MCP 工具注册
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

const PORT = 17371;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const SMOKE_TOOLS = [
    {
        type: "function",
        function: {
            name: "smoke_echo",
            description: "smoke test tool",
            parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
        },
    },
];

function readToken() {
    return JSON.parse(fs.readFileSync(os.homedir() + "/.infinite-canvas/canvas-agent.json", "utf8")).token;
}

function post(path, body, token) {
    return fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": token },
        body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

/** 浏览器闭环：SSE 连接 → 上报 → 调工具 → SSE 收到 tool_call → 回写 → /api/tools 返回结果。 */
async function browserLoop(token, clientId) {
    return new Promise((resolve) => {
        let buf = "";
        const req = http.get(`${BASE}/events?clientId=${encodeURIComponent(clientId)}&token=${encodeURIComponent(token)}`, (res) => {
            res.setEncoding("utf8");
            const timeout = setTimeout(() => { req.destroy(); resolve({ ok: false, detail: "tool_call 5s 内未收到" }); }, 5000);
            res.on("data", (chunk) => {
                buf += chunk;
                let eventType = "";
                let idx;
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const raw = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const line of raw.split("\n")) {
                        if (line.startsWith("event:")) eventType = line.slice(6).trim();
                        if (line.startsWith("data:")) {
                            const payload = JSON.parse(line.slice(5).trim());
                            if (eventType === "ready") {
                                void (async () => {
                                    await post("/canvas/state", { snapshot: { nodes: [] }, tools: SMOKE_TOOLS }, token);
                                    await post(`/canvas/activate?clientId=${encodeURIComponent(clientId)}`, {}, token);
                                    const done = await post("/api/tools", { name: "smoke_echo", input: { message: "hello" } }, token);
                                    clearTimeout(timeout);
                                    const ok = done.status === 200 && done.body?.ok === true && done.body?.result?.echo === "hello";
                                    resolve({ ok, detail: ok ? "tools 调用闭环成功" : `调用闭环异常 ${JSON.stringify(done)}` });
                                    // 注意：SSE 连接 req 保持打开，供后续 MCP 子进程复用同一画布状态
                                })();
                            }
                            if (eventType === "tool_call") {
                                void post("/canvas/result", { toolCallId: payload.toolCallId, result: { ok: true, echo: payload.input?.message || "" } }, token);
                            }
                        }
                    }
                }
            });
        });
        req.on("error", (error) => resolve({ ok: false, detail: String(error) }));
    });
}

/** MCP 子进程：initialize + tools/list 应能看到浏览器上报的工具。 */
async function mcpLoop(token) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["dist/index.js", "mcp"], { cwd: process.cwd() });
        const timeout = setTimeout(() => { child.kill(); resolve({ ok: false, detail: "MCP 超时" }); }, 8000);
        let buf = "";
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.1" } } })}\n`);
        child.stdout?.on("data", (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1) child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
                    if (msg.id === 2) {
                        clearTimeout(timeout);
                        const tools = (msg.result?.tools || []).map((t) => t.name);
                        child.kill();
                        const ok = tools.includes("smoke_echo");
                        resolve({ ok, detail: ok ? `MCP 注册工具: ${tools.join(",")}` : "MCP 未含 smoke_echo" });
                    }
                } catch { /* ignore */ }
            }
        });
        child.on("error", (error) => { clearTimeout(timeout); resolve({ ok: false, detail: String(error) }); });
        child.stderr?.on("data", (chunk) => console.log("  [mcp-stderr]", chunk.toString().slice(0, 300)));
    });
}

async function main() {
    const httpProc = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));

    try {
        const health = await fetch(`${BASE}/health`).then((r) => r.json());
        check("health", health.ok === true && health.version === "0.1.0", JSON.stringify(health).slice(0, 100));
    } catch (e) {
        check("health", false, String(e));
    }

    try {
        const config = await fetch(`${BASE}/config`).then((r) => r.json());
        const ids = (config.adapters || []).map((a) => a.id);
        check("config", config.ok === true && ids.length >= 3, `adapters=${ids.join(",")}`);
    } catch (e) {
        check("config", false, String(e));
    }

    try {
        const res = await fetch(`${BASE}/tools`);
        check("token-guard", res.status === 401, `status=${res.status}`);
    } catch (e) {
        check("token-guard", false, String(e));
    }

    const token = readToken();
    const loop = await browserLoop(token, "smoke-browser");
    check("browser-tool-loop", loop.ok, loop.detail);

    const mcp = await mcpLoop(token);
    check("mcp-tools-register", mcp.ok, mcp.detail);

    httpProc.kill("SIGTERM");
    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("SMOKE ERROR", e); process.exit(1); });