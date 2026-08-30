import {
    vaultTools,
    findVaultTool,
    parseMCPCall,
    readNoteTool,
    writeNoteTool,
    searchVaultTool,
    getArgString,
    getArgNumber,
    type VaultToolContext,
} from '../src/core/vault-tools';

function makeCtx(overrides?: Partial<VaultToolContext>): VaultToolContext {
    return {
        readNote: async (p) => p === 'a.md' ? '# A' : null,
        writeNote: async (p, c) => p === 'bad' ? { ok: false, error: '权限不足' } : { ok: true },
        searchVault: async (q, limit) => q === 'none' ? [] : [{ path: 'a.md' }].slice(0, limit),
        ...overrides,
    };
}

describe('vaultTools registry', () => {
    it('contains read_note, write_note, search_vault', () => {
        expect(vaultTools.map(t => t.name).sort()).toEqual(['read_note', 'search_vault', 'write_note']);
    });

    it('findVaultTool finds by name', () => {
        expect(findVaultTool('read_note')).toBe(readNoteTool);
        expect(findVaultTool('unknown')).toBeUndefined();
    });
});

describe('read_note', () => {
    it('returns note content', async () => {
        const result = await readNoteTool.execute({ path: 'a.md' }, makeCtx());
        expect(result.content).toBe('# A');
    });
    it('errors when path missing', async () => {
        const result = await readNoteTool.execute({}, makeCtx());
        expect(result.error).toContain('path');
    });
    it('errors when note missing', async () => {
        const result = await readNoteTool.execute({ path: 'missing.md' }, makeCtx());
        expect(result.error).toContain('不存在');
    });
});

describe('write_note', () => {
    it('writes note', async () => {
        const result = await writeNoteTool.execute({ path: 'b.md', content: 'hi' }, makeCtx());
        expect(result.content).toContain('已写入');
    });
    it('propagates write error', async () => {
        const result = await writeNoteTool.execute({ path: 'bad', content: 'hi' }, makeCtx());
        expect(result.error).toBe('权限不足');
    });
    it('errors when content missing', async () => {
        const result = await writeNoteTool.execute({ path: 'b.md' }, makeCtx());
        expect(result.error).toContain('content');
    });
});

describe('search_vault', () => {
    it('returns results as JSON', async () => {
        const result = await searchVaultTool.execute({ query: 'x', limit: 5 }, makeCtx());
        expect(JSON.parse(result.content!)).toEqual([{ path: 'a.md' }]);
    });
    it('defaults limit and returns empty', async () => {
        const result = await searchVaultTool.execute({ query: 'none' }, makeCtx());
        expect(JSON.parse(result.content!)).toEqual([]);
    });
});

describe('parseMCPCall', () => {
    it('parses MCP_CALL_JSON', () => {
        const call = parseMCPCall('请读取笔记\nMCP_CALL_JSON: {"tool":"read_note","args":{"path":"a.md"}}');
        expect(call).toEqual({ tool: 'read_note', args: { path: 'a.md' } });
    });
    it('returns null for malformed', () => {
        expect(parseMCPCall('no call here')).toBeNull();
        expect(parseMCPCall('MCP_CALL_JSON: {bad json}')).toBeNull();
    });
    it('returns null when tool missing', () => {
        expect(parseMCPCall('MCP_CALL_JSON: {"args":{}}')).toBeNull();
    });
});

describe('arg helpers', () => {
    it('getArgString only accepts strings', () => {
        expect(getArgString({ a: 'x' }, 'a')).toBe('x');
        expect(getArgString({ a: 3 }, 'a')).toBeUndefined();
        expect(getArgString({}, 'a')).toBeUndefined();
    });
    it('getArgNumber accepts numbers and numeric strings', () => {
        expect(getArgNumber({ a: 5 }, 'a')).toBe(5);
        expect(getArgNumber({ a: '7' }, 'a')).toBe(7);
        expect(getArgNumber({ a: 'x' }, 'a', 3)).toBe(3);
        expect(getArgNumber({}, 'a')).toBeUndefined();
    });
});
