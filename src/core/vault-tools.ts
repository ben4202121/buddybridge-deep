// ==================== Vault 工具接口 (方案 §2.3) ====================
// read_note / write_note / search_vault：在插件内通过 Obsidian Vault API 实现，
// 由 createVaultToolContext(app) 绑定真实 Vault；纯解析逻辑可被单测覆盖。
// DeepSeek 版主要依赖 Harness 自身的 fs/bash 工具（cwd = Vault），
// 本模块同时作为 Bao 版「虚拟 MCP」的共享执行层。

export interface ToolParameter {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    required?: boolean;
}

export interface ToolResult {
    content?: string;
    error?: string;
}

/** 供 execute 使用的最小 Vault 访问能力（由插件以 Obsidian Vault API 实现）。 */
export interface VaultToolContext {
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
    searchVault(query: string, limit: number): Promise<Array<{ path: string; snippet?: string }>>;
}

export interface VaultTool {
    name: string;
    description: string;
    parameters: ToolParameter[];
    execute(args: Record<string, unknown>, ctx: VaultToolContext): Promise<ToolResult>;
}

// ==================== 纯解析辅助 ====================

/** 从未知入参中安全提取字符串。 */
export function getArgString(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
}

/** 从未知入参中安全提取数字。 */
export function getArgNumber(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
    const v = args[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (!isNaN(n)) return n;
    }
    return fallback;
}

/** 解析 MCP_CALL_JSON 文本（Bao 虚拟 MCP 协议用；DeepSeek 版不依赖）。 */
export function parseMCPCall(text: string): { tool: string; args: Record<string, unknown> } | null {
    const match = text.match(/MCP_CALL_JSON:\s*({.+?})(?:\n|$)/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        const p = parsed as Record<string, unknown>;
        if (typeof p.tool !== 'string' || !p.tool) return null;
        const args = typeof p.args === 'object' && p.args !== null && !Array.isArray(p.args)
            ? (p.args as Record<string, unknown>)
            : {};
        return { tool: p.tool, args };
    } catch {
        return null;
    }
}

// ==================== 工具定义 ====================

export const readNoteTool: VaultTool = {
    name: 'read_note',
    description: '读取 Obsidian 笔记全文',
    parameters: [
        { name: 'path', type: 'string', description: '笔记路径', required: true },
    ],
    execute: async (args, ctx) => {
        const path = getArgString(args, 'path');
        if (!path) return { error: '参数 path 缺失' };
        const content = await ctx.readNote(path);
        if (content === null) return { error: `笔记不存在: ${path}` };
        return { content };
    },
};

export const writeNoteTool: VaultTool = {
    name: 'write_note',
    description: '创建或更新 Obsidian 笔记',
    parameters: [
        { name: 'path', type: 'string', description: '笔记路径', required: true },
        { name: 'content', type: 'string', description: '笔记内容', required: true },
    ],
    execute: async (args, ctx) => {
        const path = getArgString(args, 'path');
        const content = getArgString(args, 'content');
        if (!path) return { error: '参数 path 缺失' };
        if (content === undefined) return { error: '参数 content 缺失' };
        const result = await ctx.writeNote(path, content);
        if (!result.ok) return { error: result.error || '写入失败' };
        return { content: `已写入 ${path}` };
    },
};

export const searchVaultTool: VaultTool = {
    name: 'search_vault',
    description: '在 Vault 中搜索笔记',
    parameters: [
        { name: 'query', type: 'string', description: '搜索关键词', required: true },
        { name: 'limit', type: 'number', description: '返回条数上限', required: false },
    ],
    execute: async (args, ctx) => {
        const query = getArgString(args, 'query');
        const limit = getArgNumber(args, 'limit', 10) ?? 10;
        if (!query) return { error: '参数 query 缺失' };
        const results = await ctx.searchVault(query, Math.max(1, Math.floor(limit)));
        return { content: JSON.stringify(results, null, 2) };
    },
};

export const vaultTools: VaultTool[] = [
    readNoteTool,
    writeNoteTool,
    searchVaultTool,
];

export function findVaultTool(name: string): VaultTool | undefined {
    return vaultTools.find(t => t.name === name);
}
