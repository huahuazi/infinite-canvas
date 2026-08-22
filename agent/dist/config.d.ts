export declare const DEFAULT_PORT = 17371;
export declare const CONFIG_DIR: string;
export declare const CONFIG_FILE: string;
export declare const VERSION: string;
export declare const DEFAULT_ADAPTER = "codex";
export declare const AGENT_PROMPT: string;
export type CanvasAgentConfig = {
    url: string;
    token: string;
    origins?: string[];
    adapter?: string;
};
/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export declare function loadConfig(create?: boolean): CanvasAgentConfig;
/** 将 Canvas Agent 配置写入用户配置目录。 */
export declare function saveConfig(config: CanvasAgentConfig): void;
