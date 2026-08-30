import { buildPromptContext, buildDedupedPrompt, MAX_INJECTED_NOTE_CHARS, type PromptContextState } from '../src/context';

describe('buildPromptContext (上下文注入)', () => {
    it('injects nothing when all toggles are off', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', noteContent: '# A', vaultPath: '/vault',
            noteLinkInjection: false, vaultContextInjection: false, injectNoteContent: false,
        });
        expect(r).toBe('hi');
    });

    it('injects note path only when note toggle is on', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', noteContent: '# A', vaultPath: '/vault',
            noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: false,
        });
        expect(r).toBe('[当前笔记: a.md]\n\nhi');
    });

    it('injects vault context only when vault toggle is on', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', vaultPath: '/vault',
            noteLinkInjection: false, vaultContextInjection: true, injectNoteContent: false,
        });
        expect(r).toBe('[Vault: /vault]\n\nhi');
    });

    it('injects full note content in a markdown fence when injectNoteContent is on', () => {
        const r = buildPromptContext({
            userText: '总结', notePath: 'a.md', noteContent: '# 标题\n正文内容', vaultPath: null,
            noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: true,
        });
        expect(r).toBe('[当前笔记: a.md]\n```markdown\n# 标题\n正文内容\n```\n\n总结');
    });

    it('escapes triple backticks inside note content', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', noteContent: '```js\nx\n```', vaultPath: null,
            noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: true,
        });
        expect(r).toContain('\\`\\`\\`');
        expect(r).not.toContain('```js\nx\n```');
    });

    it('truncates oversized note content with a marker', () => {
        const big = 'x'.repeat(MAX_INJECTED_NOTE_CHARS + 100);
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', noteContent: big, vaultPath: null,
            noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: true,
        });
        expect(r).toContain('…（内容过长已截断）');
        // 注入的正文部分不超过上限 + 标记长度
        expect(r.length).toBeLessThan(MAX_INJECTED_NOTE_CHARS + 200);
    });

    it('skips note content when toggle on but content empty', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: 'a.md', noteContent: '', vaultPath: null,
            noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: true,
        });
        expect(r).toBe('[当前笔记: a.md]\n\nhi');
    });

    it('ignores missing paths even when toggles are on', () => {
        const r = buildPromptContext({
            userText: 'hi', notePath: null, noteContent: null, vaultPath: null,
            noteLinkInjection: true, vaultContextInjection: true, injectNoteContent: true,
        });
        expect(r).toBe('hi');
    });
});

describe('buildDedupedPrompt (会话内上下文去重)', () => {
    const noteOnly = { noteLinkInjection: true, vaultContextInjection: false, injectNoteContent: false };
    const allOn = { noteLinkInjection: true, vaultContextInjection: true, injectNoteContent: true };
    const allOff = { noteLinkInjection: false, vaultContextInjection: false, injectNoteContent: false };

    it('injects full context on first message (prev=null)', () => {
        const r = buildDedupedPrompt(null, { notePath: 'a.md', noteContent: null, vaultPath: null }, '你好', noteOnly);
        expect(r.text).toBe('[当前笔记: a.md]\n\n你好');
        expect(r.state).toEqual({ notePath: 'a.md', noteContent: null, vaultPath: null });
    });

    it('returns plain text when context is unchanged', () => {
        const state: PromptContextState = { notePath: 'a.md', noteContent: null, vaultPath: null };
        const r = buildDedupedPrompt(state, state, '总结下这篇文章', noteOnly);
        expect(r.text).toBe('总结下这篇文章');
        expect(r.state).toEqual(state);
    });

    it('injects new note path only when the note changes', () => {
        const r = buildDedupedPrompt(
            { notePath: 'a.md', noteContent: null, vaultPath: null },
            { notePath: 'b.md', noteContent: null, vaultPath: null },
            '总结', noteOnly);
        expect(r.text).toBe('[当前笔记: b.md]\n\n总结');
    });

    it('re-injects when note content changes (injectNoteContent on)', () => {
        const prev: PromptContextState = { notePath: 'a.md', noteContent: '# v1', vaultPath: null };
        const r = buildDedupedPrompt(
            prev,
            { notePath: 'a.md', noteContent: '# v2', vaultPath: null },
            'hi', allOn);
        expect(r.text).toContain('# v2');
        expect(r.text).not.toContain('# v1');
    });

    it('does not re-inject unchanged vault across turns', () => {
        const state: PromptContextState = { notePath: 'a.md', noteContent: null, vaultPath: '/vault' };
        const r = buildDedupedPrompt(state, state, 'hi', allOn);
        expect(r.text).toBe('hi');
    });

    it('injects vault change when vault path changes', () => {
        const r = buildDedupedPrompt(
            { notePath: null, noteContent: null, vaultPath: '/old' },
            { notePath: null, noteContent: null, vaultPath: '/new' },
            'hi', allOn);
        expect(r.text).toBe('[Vault: /new]\n\nhi');
    });

    it('prepends marker when the note is closed (non-null -> null)', () => {
        const r = buildDedupedPrompt(
            { notePath: 'a.md', noteContent: null, vaultPath: null },
            { notePath: null, noteContent: null, vaultPath: null },
            '继续', noteOnly);
        expect(r.text).toBe('[当前笔记: 无]\n\n继续');
    });

    it('no marker when note was already null', () => {
        const state: PromptContextState = { notePath: null, noteContent: null, vaultPath: null };
        const r = buildDedupedPrompt(state, state, '继续', noteOnly);
        expect(r.text).toBe('继续');
    });

    it('returns plain text when toggles are off even on context change', () => {
        const r = buildDedupedPrompt(
            { notePath: 'a.md', noteContent: null, vaultPath: null },
            { notePath: null, noteContent: null, vaultPath: null },
            'hi', allOff);
        expect(r.text).toBe('hi');
    });
});
