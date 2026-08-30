import { ConversationManager } from '../src/chat/manager';
import type { Conversation } from '../src/types';

describe('ConversationManager', () => {
    let manager: ConversationManager;
    let persisted: unknown[];

    beforeEach(() => {
        manager = new ConversationManager();
        persisted = [];
        manager.setPersistCallback(async (convs) => {
            persisted.push(convs);
        });
    });

    it('creates a conversation and sets it active', () => {
        const conv = manager.createConversation();
        expect(conv.title).toBe('新对话');
        expect(manager.getActive()?.id).toBe(conv.id);
    });

    it('creates a conversation with a custom title', () => {
        const conv = manager.createConversation('custom title');
        expect(conv.title).toBe('custom title');
    });

    it('loads conversations and activates the most recently updated', async () => {
        const conversations: Conversation[] = [
            { id: '1', title: 'first', sessionId: '', messages: [], createdAt: 100, updatedAt: 100 },
            { id: '2', title: 'second', sessionId: '', messages: [], createdAt: 200, updatedAt: 200 }
        ];
        manager.load(conversations);
        // load 按 updatedAt 降序排序，最新会话激活
        expect(manager.getActive()?.id).toBe('2');
        expect(manager.getAll()).toHaveLength(2);
        await new Promise(r => setTimeout(r, 0));
        expect(persisted.length).toBeGreaterThanOrEqual(0);
    });

    it('creates a default conversation when loading empty array', () => {
        manager.load([]);
        expect(manager.getActive()).not.toBeNull();
        expect(manager.getAll()).toHaveLength(1);
    });

    it('switches between conversations', () => {
        const a = manager.createConversation('A');
        const b = manager.createConversation('B');
        expect(manager.getActive()?.id).toBe(b.id);
        manager.switchTo(a.id);
        expect(manager.getActive()?.id).toBe(a.id);
        expect(manager.switchTo('missing')).toBeNull();
    });

    it('adds messages and updates conversation title from first user message', async () => {
        const conv = manager.createConversation();
        const msg = manager.addMessage(conv.id, 'user', 'Hello world, this is a long message');
        expect(msg).not.toBeNull();
        expect(manager.getActive()?.messages).toHaveLength(1);
        expect(manager.getActive()?.title).toBe('Hello world, this is a long me...');
        await new Promise(r => setTimeout(r, 0));
    });

    it('updates an existing message', () => {
        const conv = manager.createConversation();
        const msg = manager.addMessage(conv.id, 'assistant', 'initial');
        expect(msg).not.toBeNull();
        if (!msg) return;
        const updated = manager.updateMessage(conv.id, msg.id, 'updated');
        expect(updated).toBe(true);
        expect(manager.getActive()?.messages[0].content).toBe('updated');
    });

    it('returns false when updating a non-existent message', () => {
        const conv = manager.createConversation();
        expect(manager.updateMessage(conv.id, 'missing', 'x')).toBe(false);
    });

    it('updates message parts (thinking/tool persistence)', async () => {
        const conv = manager.createConversation();
        const msg = manager.addMessage(conv.id, 'assistant', '');
        expect(msg).not.toBeNull();
        const parts = [{ kind: 'thinking' as const, content: 'step' }];
        expect(manager.updateMessageParts(conv.id, msg!.id, parts, true)).toBe(true);
        expect(manager.getActive()?.messages[0].parts).toEqual(parts);
        expect(manager.updateMessageParts(conv.id, 'missing', parts)).toBe(false);
    });

    it('deletes a conversation and activates another', () => {
        const a = manager.createConversation('A');
        const b = manager.createConversation('B');
        expect(manager.deleteConversation(b.id)).toBe(true);
        expect(manager.getActive()?.id).toBe(a.id);
        expect(manager.deleteConversation('missing')).toBe(false);
    });

    it('sets session id', () => {
        const conv = manager.createConversation();
        expect(manager.setSessionId(conv.id, 'session-1')).toBe(true);
        expect(manager.getActive()?.sessionId).toBe('session-1');
        expect(manager.setSessionId('missing', 'session')).toBe(false);
    });

    it('flushes persistence', async () => {
        manager.createConversation('flush');
        await manager.flush();
        expect(persisted.length).toBeGreaterThan(0);
    });

    it('sets and reads maxConversations', () => {
        manager.setMaxConversations(3);
        expect(manager.getMaxConversations()).toBe(3);
        manager.setMaxConversations(-1);
        expect(manager.getMaxConversations()).toBe(3); // 非法值被忽略
    });

    it('reports atMaxConversations when reaching the limit', () => {
        manager.setMaxConversations(2);
        manager.createConversation('A');
        expect(manager.atMaxConversations()).toBe(false);
        manager.createConversation('B');
        expect(manager.atMaxConversations()).toBe(true);
    });

    it('replaceMessages copies history into a conversation (deep copy)', () => {
        const conv = manager.createConversation();
        manager.addMessage(conv.id, 'user', 'hello');
        manager.addMessage(conv.id, 'assistant', 'hi');
        const fork = manager.createConversation('fork');
        const ok = manager.replaceMessages(fork.id, conv.messages);
        expect(ok).toBe(true);
        expect(fork.messages.map(m => m.content)).toEqual(['hello', 'hi']);
        expect(fork.messages[0]).not.toBe(conv.messages[0]); // 不共享引用
        expect(manager.replaceMessages('missing', conv.messages)).toBe(false);
    });

    it('replaceMessages deep-copies parts (mutation isolation)', () => {
        const conv = manager.createConversation();
        manager.addMessage(conv.id, 'assistant', '');
        const srcMsg = conv.messages[0];
        srcMsg.parts = [{ kind: 'thinking', content: 'step1' }];
        const fork = manager.createConversation('fork');
        manager.replaceMessages(fork.id, conv.messages);
        fork.messages[0].parts![0].content = 'mutated';
        expect(srcMsg.parts![0].content).toBe('step1');
        expect(fork.messages[0].parts![0].content).toBe('mutated');
    });

    it('replaceMessages keeps updatedAt monotonic (只升不降)', () => {
        const conv = manager.createConversation();
        manager.addMessage(conv.id, 'user', 'hello');
        // 分叉会话创建即带单调递增 updatedAt（createConversation 的 max+1），可能已超出当前时间。
        // 先固定期望值（确定性，不重新取 Date.now()，避免毫秒跳变导致 flaky）。
        const raised = conv.updatedAt + 100_000;
        conv.updatedAt = raised;
        manager.replaceMessages(conv.id, conv.messages);
        // 必须保持原值，不能回退到 Date.now()
        expect(conv.updatedAt).toBe(raised);
    });

    it('fork ordering: 分叉会话不落到旧会话后面（只升不降真实场景）', async () => {
        const a = manager.createConversation('A');
        manager.addMessage(a.id, 'user', 'q1');
        await new Promise(r => setTimeout(r, 5));
        const b = manager.createConversation('B');
        manager.addMessage(b.id, 'user', 'q2');
        // 真实分叉时序：createConversation 的 max+1 保证分叉 updatedAt ≥ B，replaceMessages 不回退
        const fork = manager.createConversation('B（分支）');
        manager.replaceMessages(fork.id, b.messages);
        const order = manager.getAll().map(c => c.id);
        expect(order[0]).toBe(fork.id);
        expect(order.indexOf(fork.id)).toBeLessThan(order.indexOf(a.id));
    });

    it('sets and clears forkTranscript without touching updatedAt', () => {
        const conv = manager.createConversation();
        expect(manager.setForkTranscript(conv.id, 'transcript')).toBe(true);
        expect(conv.forkTranscript).toBe('transcript');
        const before = conv.updatedAt;
        expect(manager.setForkTranscript(conv.id, 't2')).toBe(true);
        expect(conv.updatedAt).toBe(before); // 转写不是用户活动，不参与排序
        expect(manager.setForkTranscript(conv.id, undefined)).toBe(true);
        expect(conv.forkTranscript).toBeUndefined();
        expect(manager.setForkTranscript('missing', 'x')).toBe(false);
    });

    it('direction A: createConversation does not auto-trim beyond max', async () => {
        manager.setMaxConversations(2);
        const a = manager.createConversation('A');
        await new Promise(r => setTimeout(r, 5));
        const b = manager.createConversation('B');
        await new Promise(r => setTimeout(r, 5));
        const c = manager.createConversation('C');

        // 方向 A：不再自动删除旧会话——三个都在，达到上限由 UI 守卫提示（atMaxConversations）
        expect(manager.getAll()).toHaveLength(3);
        expect(manager.atMaxConversations()).toBe(true);
        expect(manager.getAll().some(x => x.id === a.id)).toBe(true);
        expect(manager.getActive()?.id).toBe(c.id);
    });

    it('does not trim when within limit', async () => {
        manager.setMaxConversations(5);
        manager.createConversation('A');
        manager.createConversation('B');
        expect(manager.getAll()).toHaveLength(2);
    });

    it('direction A: delete below the limit clears atMaxConversations', () => {
        manager.setMaxConversations(2);
        const a = manager.createConversation('A');
        manager.createConversation('B');
        expect(manager.atMaxConversations()).toBe(true);
        manager.deleteConversation(a.id);
        expect(manager.atMaxConversations()).toBe(false);
    });

    it('removes specified messages (retry support)', async () => {
        const conv = manager.createConversation();
        const u = manager.addMessage(conv.id, 'user', 'hello');
        const a = manager.addMessage(conv.id, 'assistant', '错误: boom');
        expect(conv.messages).toHaveLength(2);

        const removed = manager.removeMessages(conv.id, [u!.id, a!.id]);
        expect(removed).toBe(2);
        expect(manager.getActive()?.messages).toHaveLength(0);

        expect(manager.removeMessages(conv.id, ['missing'])).toBe(0);
        expect(manager.removeMessages('missing-conv', ['x'])).toBe(0);
    });

    it('clears a conversation (/clear 语义): messages/title/sessionId/forkTranscript reset', () => {
        const conv = manager.createConversation();
        manager.setSessionId(conv.id, 'session-9');
        manager.setForkTranscript(conv.id, 'pending-transcript');
        manager.addMessage(conv.id, 'user', 'hello');
        manager.addMessage(conv.id, 'assistant', 'hi');
        const ok = manager.clearConversation(conv.id);
        expect(ok).toBe(true);
        expect(conv.messages).toEqual([]);
        expect(conv.title).toBe('新对话');
        expect(conv.sessionId).toBe('');
        expect(conv.forkTranscript).toBeUndefined();
        expect(conv.updatedAt).toBeGreaterThanOrEqual(conv.createdAt);
        expect(manager.clearConversation('missing')).toBe(false);
    });
});
