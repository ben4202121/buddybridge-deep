// ==================== StreamChunk 契约 (方案 §2.2) ====================
// 与 BuddyBridge v1 保持兼容，扩展 toolCallId 与 usage。

export interface StreamUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
}

export type StreamChunk =
    | { type: 'thinking'; content: string }
    | { type: 'text'; content: string }
    | { type: 'tool'; toolName: string; toolDetail: string; toolCallId: string }
    | { type: 'error'; content: string }
    | { type: 'done'; usage?: StreamUsage };
