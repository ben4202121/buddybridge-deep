import {
    DEFAULT_SETTINGS,
    migrateSettings,
    normalizeConversation,
    normalizePersistedData,
    getErrorMessage,
    generateId,
} from '../src/types';

describe('migrateSettings', () => {
    it('returns defaults for non-object input', () => {
        expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(migrateSettings('x')).toEqual(DEFAULT_SETTINGS);
    });

    it('fills missing fields with defaults', () => {
        const result = migrateSettings({});
        expect(result).toEqual(DEFAULT_SETTINGS);
        expect(result.version).toBe(5);
    });

    it('preserves valid provided fields', () => {
        const result = migrateSettings({
            acpCommand: 'dsh --profile acp',
            maxConversations: 5,
            primaryColor: '#123456',
            timeoutSeconds: 60,
            noteLinkInjection: false,
            vaultContextInjection: true,
            injectNoteContent: true,
        });
        expect(result.acpCommand).toBe('dsh --profile acp');
        expect(result.maxConversations).toBe(5);
        expect(result.primaryColor).toBe('#123456');
        expect(result.timeoutSeconds).toBe(60);
        expect(result.noteLinkInjection).toBe(false);
        expect(result.vaultContextInjection).toBe(true);
        expect(result.injectNoteContent).toBe(true);
        expect(result.version).toBe(5);
    });

    it('language 字段：合法值保留，非法回落 auto（3.3）', () => {
        expect(migrateSettings({ language: 'en' }).language).toBe('en');
        expect(migrateSettings({ language: 'zh' }).language).toBe('zh');
        expect(migrateSettings({ language: 'auto' }).language).toBe('auto');
        expect(migrateSettings({ language: 'fr' }).language).toBe('auto');
        expect(migrateSettings({}).language).toBe(DEFAULT_SETTINGS.language);
    });

    it('apiKey 字段：字符串保留，缺失/非法回落空串（4.0 插件内密钥配置）', () => {
        expect(migrateSettings({ apiKey: 'sk-abc123' }).apiKey).toBe('sk-abc123');
        expect(migrateSettings({}).apiKey).toBe(DEFAULT_SETTINGS.apiKey);
        expect(migrateSettings({ apiKey: 123 }).apiKey).toBe(DEFAULT_SETTINGS.apiKey);
    });

    it('baseUrl 字段：字符串保留，缺失/非法回落空串（4.2 DSH Web 地址共用）', () => {
        expect(migrateSettings({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' }).baseUrl)
            .toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
        expect(migrateSettings({}).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
        expect(migrateSettings({ baseUrl: 123 }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    });

    it('rejects invalid numbers and falls back to defaults', () => {
        const result = migrateSettings({ maxConversations: -3, timeoutSeconds: 0 });
        expect(result.maxConversations).toBe(DEFAULT_SETTINGS.maxConversations);
        expect(result.timeoutSeconds).toBe(DEFAULT_SETTINGS.timeoutSeconds);
    });

    it('preserves fontSize within 12-18 range and rejects out-of-range', () => {
        expect(migrateSettings({ fontSize: 16 }).fontSize).toBe(16);
        expect(migrateSettings({ fontSize: 12 }).fontSize).toBe(12);
        expect(migrateSettings({ fontSize: 18 }).fontSize).toBe(18);
        expect(migrateSettings({ fontSize: 11 }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
        expect(migrateSettings({ fontSize: 19 }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
        expect(migrateSettings({ fontSize: 'big' }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
        expect(migrateSettings({}).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    });

    it('treats non-boolean toggles as defaults', () => {
        const result = migrateSettings({ noteLinkInjection: 'yes', injectNoteContent: 1 });
        expect(result.noteLinkInjection).toBe(true);
        // 规范 P1：injectNoteContent 默认开启
        expect(result.injectNoteContent).toBe(true);
    });
});

describe('normalizeConversation', () => {
    it('returns null for invalid input', () => {
        expect(normalizeConversation(null)).toBeNull();
        expect(normalizeConversation('x')).toBeNull();
        expect(normalizeConversation([1])).toBeNull();
    });

    it('fills defaults for missing fields', () => {
        const conv = normalizeConversation({});
        expect(conv).not.toBeNull();
        expect(conv!.title).toBe('新对话');
        expect(conv!.sessionId).toBe('');
        expect(conv!.messages).toEqual([]);
        expect(conv!.createdAt).toBeGreaterThan(0);
    });

    it('preserves provided values', () => {
        const conv = normalizeConversation({ id: 'abc', title: 'T', sessionId: 's1', messages: [{ x: 1 }], createdAt: 123, updatedAt: 456 });
        expect(conv).not.toBeNull();
        expect(conv!.id).toBe('abc');
        expect(conv!.title).toBe('T');
        expect(conv!.sessionId).toBe('s1');
        expect(conv!.messages).toEqual([{ x: 1 }]);
        expect(conv!.createdAt).toBe(123);
        expect(conv!.updatedAt).toBe(456);
    });

    it('preserves forkTranscript through persistence round-trip (1.3 重载不丢)', () => {
        const conv = normalizeConversation({ id: 'f1', forkTranscript: '[系统注入·分支上下文] ...' });
        expect(conv).not.toBeNull();
        expect(conv!.forkTranscript).toBe('[系统注入·分支上下文] ...');
        // 旧数据无该字段 → undefined（向后兼容）
        expect(normalizeConversation({ id: 'f2' })!.forkTranscript).toBeUndefined();
    });
});

describe('normalizePersistedData', () => {
    it('normalizes conversations and settings', () => {
        const data = normalizePersistedData({
            dataVersion: 1,
            conversations: [{ id: 'a', messages: [] }],
            settings: { acpCommand: 'dsh' },
        });
        expect(data.dataVersion).toBe(1);
        expect(data.conversations!.length).toBe(1);
        expect(data.conversations![0].id).toBe('a');
        expect(data.settings!.acpCommand).toBe('dsh');
    });

    it('drops invalid conversations', () => {
        const data = normalizePersistedData({ conversations: [null, 'x', { id: 'ok' }] });
        expect(data.conversations!.length).toBe(1);
        expect(data.conversations![0].id).toBe('ok');
    });

    it('handles non-object input', () => {
        expect(normalizePersistedData(null).conversations).toBeUndefined();
        expect(normalizePersistedData('x').dataVersion).toBe(1);
    });
});

describe('helpers', () => {
    it('getErrorMessage returns message for Error', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });
    it('getErrorMessage returns string as-is', () => {
        expect(getErrorMessage('oops')).toBe('oops');
    });
    it('getErrorMessage returns fallback for unknown', () => {
        expect(getErrorMessage(undefined)).toBe('未知错误');
    });
    it('generateId produces uuid-like string', () => {
        const id = generateId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(generateId()).not.toBe(id);
    });
});
