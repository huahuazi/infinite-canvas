/** 安全读取未知对象中的指定字段。 */
export function field(value, key) {
    return value && typeof value === "object" ? value[key] : undefined;
}
/** 将未知异常转换为可展示的错误信息。 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
