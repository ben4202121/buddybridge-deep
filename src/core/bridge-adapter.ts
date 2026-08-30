// ==================== BridgeAdapter 抽象层 (方案 §2.1) ====================
// 两个插件（DeepSeek / Bao）共享本接口；差异仅在 bridges/ 下的 CLI 适配层实现。
// 与方案 §2.1 的差异说明：
//   - sendMessage 增加 sessionId 参数：真实 ACP 协议按 session 关联 prompt，
//     多轮对话必须复用同一 sessionId（createSession 返回后由上层保存）。
//   - 增加 cancel / setPermissionHandler，用于停止流式与权限弹窗决策。

import type { StreamChunk } from './stream-chunk';

export interface BridgeCapabilities {
    /** 是否原生支持流式 */
    streaming: boolean;
    /** 是否暴露思考过程 */
    thinking: boolean;
    /** 是否支持工具调用 */
    toolUse: boolean;
    /** 是否支持多会话 */
    sessionManagement: boolean;
    /** 是否可读写 Vault */
    workspaceAccess: boolean;
}

export interface UserMessage {
    content: string;
}

export interface VaultContext {
    currentNote?: { path: string; content: string; cursorPosition?: number };
    referencedNotes?: Array<{ path: string; content: string; context?: string }>;
    selectedText?: string;
    vaultFiles?: string[];
}

export interface BridgeConfig {
    /** ACP 启动命令（如 "dsh --profile acp" 或 "dsh-acp-demo -c C:\\path\\cordis.yml"）；留空自动检测。 */
    command?: string;
    /** 工作目录（Vault 根路径）；作为 ACP 进程 cwd，让 Harness 的 fs/bash 工具直接读写 Vault。 */
    vaultPath?: string;
    /** 单次请求超时（毫秒）。 */
    timeoutMs?: number;
    /** DeepSeek API key（可选）：注入 ACP 进程环境变量 DEEPSEEK_API_KEY，供 deepseek-official provider 使用。 */
    apiKey?: string;
    /** DeepSeek API 地址（可选）：注入 ACP 进程环境变量 DEEPSEEK_BASE_URL（官方 dsh-llm-deepseek 支持），与 DSH Web 共用。 */
    baseUrl?: string;
}

export interface DiagnosticCheck {
    name: string;
    passed: boolean;
    message?: string;
    fix?: string;
}

export interface DiagnosticResult {
    status: 'ok' | 'warning' | 'error';
    checks: DiagnosticCheck[];
}

export interface ToolCall {
    toolCallId: string;
    name?: string;
    title?: string;
    rawInput?: unknown;
}

export interface ToolResult {
    content?: string;
    error?: string;
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
    optionId: string;
    name: string;
    kind: PermissionOptionKind;
}

export interface PermissionRequest {
    sessionId: string;
    toolCall: ToolCall;
    options: PermissionOption[];
}

export interface PermissionResponse {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
}

export interface SessionInfo {
    id: string;
    title?: string;
}

export interface BridgeAdapter {
    readonly name: string;
    readonly capabilities: BridgeCapabilities;

    // 生命周期
    initialize(config: BridgeConfig): Promise<void>;
    dispose(): Promise<void>;

    // 通信
    createSession(cwd?: string): Promise<string>;
    sendMessage(sessionId: string, message: UserMessage, context: VaultContext): AsyncIterable<StreamChunk>;
    /** 停止指定会话（或全部）的流式响应；resolve 表示取消已彻底落定（可安全复用该 session）。 */
    cancel(sessionId?: string): Promise<void>;
    listSessions?(): Promise<SessionInfo[]>;
    loadSession?(sessionId: string): Promise<void>;

    // 工具 / 权限
    handleToolCall?(toolCall: ToolCall): Promise<ToolResult>;
    /** 设置权限请求处理器（插件层注入 Obsidian 弹窗决策）。 */
    setPermissionHandler?(handler: (request: PermissionRequest) => Promise<PermissionResponse>): void;

    // 诊断
    diagnose(): Promise<DiagnosticResult>;
}
