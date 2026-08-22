/** 管理 Canvas Agent 的终端与文件 Debug 日志。 */
export declare class Logger {
    readonly enabled: boolean;
    readonly filePath: string;
    private readonly logger;
    /** 普通模式输出 Info 以上日志，Debug 模式额外输出 Debug 并写入文件。 */
    constructor();
    /** 输出 Debug 级别日志。 */
    debug(message: string, details?: unknown): void;
    /** 输出 Info 级别日志。 */
    info(message: string, details?: unknown): void;
    /** 输出 Warn 级别日志。 */
    warn(message: string, details?: unknown): void;
    /** 输出 Error 级别日志。 */
    error(message: string, details?: unknown): void;
}
export declare const logger: Logger;
