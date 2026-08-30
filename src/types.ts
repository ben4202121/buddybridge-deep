// ==================== 聊天类型 ====================

/** 消息的结构化组成部分（思考 / 工具调用），用于在流式结束后仍能重建可折叠的展示块。 */
export interface MessagePart {
    kind: 'thinking' | 'tool';
    /** thinking 的内容 */
    content?: string;
    /** tool 的名称 */
    name?: string;
    /** tool 的入参描述 */
    detail?: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    /** 结构化 parts（可选，向后兼容：旧数据无此字段仅渲染纯文本） */
    parts?: MessagePart[];
}

export interface Conversation {
    id: string;
    title: string;
    /** DeepSeek ACP session id（首次发送时由 createSession 分配） */
    sessionId: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
    /**
     * 分支注入转写（可选）：分支会话待发送的「截至分叉点的对话转写」。
     * 持久化在会话上（跨视图重载/重启不丢），首条发送时读取即清除。
     */
    forkTranscript?: string;
}

// ==================== 设置类型 ====================
/** 聊天区字体大小范围（px）。 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;

export interface BuddyBridgeSettings {
    /** ACP 启动命令，如 "dsh --profile acp" 或 "dsh-acp-demo -c <path>"; 留空自动检测 */
    acpCommand: string;
    maxConversations: number;
    primaryColor: string;
    /** 聊天区字体大小（px，气泡 / Markdown 内容 / 输入框 / 排队项），默认 14 */
    fontSize: number;
    /** 请求超时（秒），默认 300 */
    timeoutSeconds: number;
    /** 发送消息时自动注入当前笔记路径（当前文档感知开关） */
    noteLinkInjection: boolean;
    /** 发送消息时额外注入 Vault 根路径 */
    vaultContextInjection: boolean;
    /** 额外注入当前笔记全文（默认关闭，避免撑爆上下文；Harness 有 fs 工具可自行读取） */
    injectNoteContent: boolean;
    /** 界面语言（3.3 i18n）：'auto' 跟随 Obsidian locale */
    language: 'zh' | 'en' | 'auto';
    /** DeepSeek API key（供 deepseek-official provider）。在插件内配置，启动 dsh 进程时注入环境变量，免去系统级环境变量操作。 */
    apiKey: string;
    /**
     * DeepSeek API 地址（可选）：与 DSH Web 共用，从 DSH Web 设置复制。
     * 留空使用官方默认 https://api.deepseek.com；火山方舟等第三方端点在此配置。
     * 注入 ACP 进程环境变量 DEEPSEEK_BASE_URL（官方 dsh-llm-deepseek 支持）。 */
    baseUrl: string;
    version: number;
}

/** 当前设置版本号。新增设置项时递增；migrateSettings 补齐旧数据。 */
const CURRENT_SETTINGS_VERSION = 5;

/** 持久化数据 blob 的格式版本号。 */
export const DATA_VERSION = 1;

export const DEFAULT_SETTINGS: BuddyBridgeSettings = {
    acpCommand: '',
    maxConversations: 20,
    primaryColor: '',
    fontSize: 14,
    timeoutSeconds: 300,
    noteLinkInjection: true,
    vaultContextInjection: false,
    // 规范 §3.3 P1 要求「自动注入当前笔记全文」：默认开启（带长度上限，见 context.ts）
    injectNoteContent: true,
    language: 'auto',
    apiKey: '',
    baseUrl: '',
    version: CURRENT_SETTINGS_VERSION,
};

// ==================== 通用类型安全辅助函数 ====================

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(data: Record<string, unknown>, key: string): string | undefined {
    const value = data[key];
    return typeof value === 'string' ? value : undefined;
}

export function getNumber(data: Record<string, unknown>, key: string): number | undefined {
    const value = data[key];
    return typeof value === 'number' ? value : undefined;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return '未知错误';
}

/**
 * 迁移设置到最新版本（参考 Claudian 的 normalize+migrate 模式）。
 * 对每个字段做类型安全的归一化，旧数据缺字段时全部回落默认值。
 */
export function migrateSettings(stored: unknown): BuddyBridgeSettings {
    if (!isObject(stored)) {
        return { ...DEFAULT_SETTINGS };
    }

    const maxConversations = getNumber(stored, 'maxConversations');
    const primaryColor = getString(stored, 'primaryColor');
    const fontSize = getNumber(stored, 'fontSize');
    const timeoutSeconds = getNumber(stored, 'timeoutSeconds');
    const acpCommand = getString(stored, 'acpCommand');

    const boolField = (key: string, fallback: boolean): boolean =>
        typeof stored[key] === 'boolean' ? stored[key] as boolean : fallback;

    return {
        acpCommand: acpCommand ?? DEFAULT_SETTINGS.acpCommand,
        maxConversations: typeof maxConversations === 'number' && maxConversations > 0
            ? maxConversations
            : DEFAULT_SETTINGS.maxConversations,
        primaryColor: primaryColor ?? DEFAULT_SETTINGS.primaryColor,
        fontSize: typeof fontSize === 'number' && fontSize >= FONT_SIZE_MIN && fontSize <= FONT_SIZE_MAX
            ? fontSize
            : DEFAULT_SETTINGS.fontSize,
        timeoutSeconds: typeof timeoutSeconds === 'number' && timeoutSeconds > 0
            ? timeoutSeconds
            : DEFAULT_SETTINGS.timeoutSeconds,
        noteLinkInjection: boolField('noteLinkInjection', DEFAULT_SETTINGS.noteLinkInjection),
        vaultContextInjection: boolField('vaultContextInjection', DEFAULT_SETTINGS.vaultContextInjection),
        injectNoteContent: boolField('injectNoteContent', DEFAULT_SETTINGS.injectNoteContent),
        language: (stored.language === 'zh' || stored.language === 'en' || stored.language === 'auto')
            ? stored.language
            : DEFAULT_SETTINGS.language,
        apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : DEFAULT_SETTINGS.apiKey,
        baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : DEFAULT_SETTINGS.baseUrl,
        version: CURRENT_SETTINGS_VERSION,
    };
}

// ==================== 工具函数 ====================

export function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ==================== 持久化数据类型 ====================

export interface PersistedData {
    dataVersion?: number;
    conversations?: Conversation[];
    settings?: Partial<BuddyBridgeSettings>;
}

export function normalizeConversation(raw: unknown): Conversation | null {
    if (!isObject(raw)) return null;
    const id = getString(raw, 'id') ?? generateId();
    const title = getString(raw, 'title') ?? '新对话';
    const sessionId = getString(raw, 'sessionId') ?? '';
    const messages = Array.isArray(raw.messages) ? raw.messages as ChatMessage[] : [];
    const createdAt = getNumber(raw, 'createdAt') ?? Date.now();
    const updatedAt = getNumber(raw, 'updatedAt') ?? createdAt;
    return { id, title, sessionId, messages, createdAt, updatedAt, forkTranscript: getString(raw, 'forkTranscript') };
}

export function normalizePersistedData(raw: unknown): PersistedData {
    const result: PersistedData = { dataVersion: DATA_VERSION };
    if (!isObject(raw)) {
        return result;
    }

    const dataVersion = getNumber(raw, 'dataVersion');
    if (typeof dataVersion === 'number') {
        result.dataVersion = dataVersion;
    }

    if (Array.isArray(raw.conversations)) {
        const convs: Conversation[] = [];
        for (const item of raw.conversations) {
            const conv = normalizeConversation(item);
            if (conv) convs.push(conv);
        }
        result.conversations = convs;
    }

    if (isObject(raw.settings)) {
        result.settings = migrateSettings(raw.settings);
    }

    return result;
}
