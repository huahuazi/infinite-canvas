import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const DEFAULT_ADAPTER = "codex";

/** 读取 Agent 指令：优先随包路径，其次可执行文件同目录（bun 单文件产物场景）。 */
function loadAgentPrompt(): string {
    const candidates = [
        new URL("../agent-instructions.md", import.meta.url),
        path.join(path.dirname(process.execPath), "agent-instructions.md"),
    ];
    for (const candidate of candidates) {
        try {
            return fs.readFileSync(candidate, "utf8");
        } catch {
            // 尝试下一个候选路径
        }
    }
    throw new Error("agent-instructions.md 缺失，请确认与程序放在同一目录");
}
export const AGENT_PROMPT = loadAgentPrompt();

export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; adapter?: string };

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** 从当前包信息中读取版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}