export type JsonRecord = Record<string, unknown>;
/** 安全读取未知对象中的指定字段。 */
export declare function field(value: unknown, key: string): unknown;
/** 将未知异常转换为可展示的错误信息。 */
export declare function errorMessage(error: unknown): string;
