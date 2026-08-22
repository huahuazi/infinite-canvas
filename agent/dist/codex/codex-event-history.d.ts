import type { CodexSupplementalHistory, CodexSupplementalHistoryItem, CodexSupplementalHistoryTurn } from "./codex-history.js";
export declare const CODEX_EVENT_HISTORY_FILE: string;
/** 保存 Codex 持久线程投影可能省略的实时完成事件。 */
export declare class CodexEventHistory {
    private file;
    private data?;
    private queue;
    constructor(file?: string);
    /** 按 threadId、turnId 和 itemId 新增或更新一条补充事件。 */
    record(entry: CodexSupplementalHistoryItem): Promise<void>;
    /** 保存 turn 终态，使标准线程历史尚未物化时仍可恢复完整轮次。 */
    recordTurn(entry: CodexSupplementalHistoryTurn): Promise<void>;
    /** 按 item 开始顺序返回指定线程的补充事件。 */
    readThread(threadId: string): Promise<CodexSupplementalHistory>;
    /** 归档线程后删除其补充事件。 */
    removeThread(threadId: string): Promise<void>;
    private run;
    private load;
    private save;
}
export declare const codexEventHistory: CodexEventHistory;
