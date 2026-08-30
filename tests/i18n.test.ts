import { t, setLanguage, getLang, detectObsidianLocale, friendlyError } from '../src/i18n';

describe('i18n (Phase 3.3)', () => {
    afterEach(() => {
        setLanguage('zh');
    });

    it('默认中文（zh）', () => {
        setLanguage('zh');
        expect(getLang()).toBe('zh');
        expect(t('chat.send')).toBe('发送');
    });

    it('setLanguage(en) 返回英文', () => {
        setLanguage('en');
        expect(getLang()).toBe('en');
        expect(t('chat.send')).toBe('Send');
        expect(t('set.langName')).toBe('Language');
    });

    it('setLanguage(auto) 按 window.moment locale 解析', () => {
        (window as unknown as { moment?: { locale?: () => string } }).moment = { locale: () => 'zh-CN' };
        setLanguage('auto');
        expect(getLang()).toBe('zh');
        (window as unknown as { moment?: { locale?: () => string } }).moment = { locale: () => 'en-US' };
        setLanguage('auto');
        expect(getLang()).toBe('en');
        (window as unknown as { moment?: { locale?: () => string } }).moment = { locale: () => 'de' };
        setLanguage('auto');
        expect(getLang()).toBe('en'); // 非 zh 前缀 → 英文
    });

    it('未知 key 回退 key 本身', () => {
        expect(t('no.such.key')).toBe('no.such.key');
    });

    it('{var} 插值', () => {
        setLanguage('zh');
        expect(t('chat.convFull', { max: 20 })).toBe('对话已满（最多 20 个），请先删除旧对话再新建');
        setLanguage('en');
        expect(t('chat.convFull', { max: 20 })).toBe('Too many conversations (max 20). Delete one to create a new one.');
    });

    it('detectObsidianLocale 兜底中文（无 moment 时）', () => {
        (window as unknown as { moment?: unknown }).moment = undefined;
        expect(detectObsidianLocale()).toBe('zh');
    });

    it('friendlyError：no API key → 双语文案（4.0 友好化）', () => {
        setLanguage('zh');
        const zh = friendlyError('Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"');
        expect(zh).toContain('DeepSeek API Key');
        expect(zh).toContain('粘贴');
        setLanguage('en');
        const en = friendlyError('Internal error: no API key for provider route');
        expect(en).toContain('DeepSeek API Key');
        expect(en).toContain('Settings');
    });

    it('friendlyError：未命中场景原样返回，不吞错误', () => {
        setLanguage('zh');
        expect(friendlyError('Connection refused: ECONNREFUSED')).toBe('Connection refused: ECONNREFUSED');
        expect(friendlyError('')).toBe('');
    });
});
