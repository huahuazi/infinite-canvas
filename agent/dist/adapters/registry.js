import { DEFAULT_ADAPTER } from "../config.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { defaultGenericCliConfig, GenericCliAdapter } from "./generic-cli.js";
import { HttpAgentAdapter } from "./http-agent.js";
/**
 * 适配器注册表。Codex / Claude Code 为内置后端；
 * 通用 CLI 与 OpenAI 兼容端点由 HTTP 配置层按需实例化。
 */
export class AdapterRegistry {
    adapters = new Map();
    order = [];
    constructor() {
        const generic = defaultGenericCliConfig();
        this.register(new CodexAdapter());
        this.register(new ClaudeCodeAdapter());
        for (const [id, config] of Object.entries(generic))
            this.register(new GenericCliAdapter(config), id);
        let defaultAdapter = DEFAULT_ADAPTER;
        if (!this.adapters.has(defaultAdapter))
            defaultAdapter = this.order[0] || "codex";
        this.adapters.get(defaultAdapter)?.start(() => undefined).catch(() => undefined);
    }
    register(adapter, idOverride) {
        const id = idOverride || adapter.id;
        this.adapters.set(id, adapter);
        this.order.push(id);
    }
    /** 注册 OpenAI 兼容端点适配器（配置后调用）。 */
    addHttpAgent(id, config) {
        if (this.adapters.has(id))
            return false;
        this.adapters.set(id, new HttpAgentAdapter(config));
        this.order.push(id);
        return true;
    }
    get(id) {
        return this.adapters.get(id);
    }
    list() {
        return this.order.map((id) => {
            const adapter = this.adapters.get(id);
            return { id, label: adapter.label, capabilities: [...adapter.capabilities] };
        });
    }
    defaultId() {
        return this.adapters.has(DEFAULT_ADAPTER) ? DEFAULT_ADAPTER : this.order[0] || "codex";
    }
}
export const adapterRegistry = new AdapterRegistry();
