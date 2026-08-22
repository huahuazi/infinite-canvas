export type CodexSupplementalHistoryItem = { threadId: string; turnId: string; itemId: string; sequence?: number; item: Record<string, unknown> };
export type CodexSupplementalHistoryTurn = { threadId: string; turnId: string; turn: Record<string, unknown> };
export type CodexSupplementalHistory = { items: CodexSupplementalHistoryItem[]; turns: CodexSupplementalHistoryTurn[] };