import type { Conversation, ChatMessage, MessagePart } from '../types';
import { generateId, getErrorMessage } from '../types';

export class ConversationManager {
    private conversations: Map<string, Conversation> = new Map();
    private activeId: string | null = null;
    private maxConversations = 20;
    private persistCallback: ((convs: Conversation[]) => Promise<void>) | null = null;
    /** 串行化持久化链：避免并发的 read-modify-write 造成磁盘回退丢数据（B1）。 */
    private persistChain: Promise<void> = Promise.resolve();

    setPersistCallback(callback: (convs: Conversation[]) => Promise<void>) {
        this.persistCallback = callback;
    }

    /** 设置最大对话数（方向 A：达到上限由 UI 层守卫禁止新建，不再自动裁剪）。 */
    setMaxConversations(max: number): void {
        if (typeof max === 'number' && max > 0) {
            this.maxConversations = max;
        }
    }

    getMaxConversations(): number {
        return this.maxConversations;
    }

    /** 是否已达到最大对话数（方向 A：达到上限禁止新建，由 UI 层守卫提示）。 */
    atMaxConversations(): boolean {
        return this.conversations.size >= this.maxConversations;
    }

    /**
     * 排队持久化：快照在调用时同步取，写盘经单一 promise 链串行执行，
     * 保证完成顺序与调用顺序一致（即使 loadData 慢也不会被旧快照覆盖）。
     */
    private persist(): Promise<void> {
        if (!this.persistCallback) return Promise.resolve();
        const snapshot = this.getAll();
        this.persistChain = this.persistChain
            .then(() => this.persistCallback(snapshot))
            .catch((err) => this.handlePersistError(err));
        return this.persistChain;
    }

    private handlePersistError(error: unknown) {
        console.error('[BD] persist failed:', getErrorMessage(error));
    }

    /** 显式触发持久化（流式结束后调用）：等待队列排空。 */
    async flush(): Promise<void> {
        await this.persistChain;
    }

    /** 从持久化数据加载对话（按 updatedAt 降序，保证最新会话激活）。 */
    load(conversations: Conversation[]) {
        if (!conversations || conversations.length === 0) {
            this.createConversation();
            return;
        }
        const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
        for (const conv of sorted) {
            this.conversations.set(conv.id, { ...conv });
        }
        this.activeId = sorted[0].id;
    }

    /** 创建新对话 */
    createConversation(title?: string): Conversation {
        const id = generateId();
        let updatedAt = Date.now();
        for (const c of this.conversations.values()) {
            if (c.updatedAt >= updatedAt) updatedAt = c.updatedAt + 1;
        }
        const conv: Conversation = {
            id,
            title: title || '新对话',
            sessionId: '',
            messages: [],
            createdAt: Date.now(),
            updatedAt,
        };
        this.conversations.set(id, conv);
        this.activeId = id;
        this.persist().catch((err) => this.handlePersistError(err));
        return conv;
    }

    /** 删除指定消息（用于错误卡重试时移除失败的 user+assistant 对）。返回实际删除条数。 */
    removeMessages(convId: string, ids: string[]): number {
        const conv = this.conversations.get(convId);
        if (!conv || !ids || ids.length === 0) return 0;
        const before = conv.messages.length;
        conv.messages = conv.messages.filter(m => !ids.includes(m.id));
        const removed = before - conv.messages.length;
        if (removed > 0) {
            conv.updatedAt = Date.now();
            this.persist().catch((err) => this.handlePersistError(err));
        }
        return removed;
    }

    /**
     * 批量替换指定会话的消息列表（用于分支复制历史），持久化一次。
     * 深度拷贝消息与 parts，避免新会话与源会话共享引用（一侧改动影响另一侧）。
     */
    replaceMessages(convId: string, messages: ChatMessage[]): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        conv.messages = messages.map(m => ({
            ...m,
            parts: m.parts ? m.parts.map(p => ({ ...p })) : undefined,
        }));
        // 只升不降：分叉会话创建时已带单调递增的 updatedAt（createConversation 的 max+1），
        // 这里若回退到 Date.now() 会让新分叉排序落到旧会话后面（分叉后找不到）。
        conv.updatedAt = Math.max(conv.updatedAt, Date.now());
        this.persist().catch((err) => this.handlePersistError(err));
        return true;
    }

    /** 清除指定对话的所有消息并重置标题（/clear 语义：清当前对话，不新建）。
     * 同时重置 sessionId —— ACP 侧会话历史彻底作废，下一条消息换新 session 全新开始。 */
    clearConversation(convId: string): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        conv.messages = [];
        conv.title = '新对话';
        conv.sessionId = '';
        conv.updatedAt = Date.now();
        // 残留的分支注入转写一并清除（清空后不再注入旧上下文）
        delete conv.forkTranscript;
        this.persist().catch((err) => this.handlePersistError(err));
        return true;
    }

    /** 删除对话 */
    deleteConversation(id: string): boolean {
        if (!this.conversations.has(id)) return false;
        this.conversations.delete(id);
        if (this.activeId === id) {
            const remaining = this.getAll();
            this.activeId = remaining.length > 0 ? remaining[0].id : null;
        }
        this.persist().catch((err) => this.handlePersistError(err));
        return true;
    }

    /** 切换到指定对话 */
    switchTo(id: string): Conversation | null {
        const conv = this.conversations.get(id);
        if (!conv) return null;
        this.activeId = id;
        return conv;
    }

    /** 获取当前活跃对话 */
    getActive(): Conversation | null {
        if (!this.activeId) return null;
        return this.conversations.get(this.activeId) || null;
    }

    /** 按 id 获取对话（不存在返回 null）。 */
    getConversation(id: string): Conversation | null {
        return this.conversations.get(id) || null;
    }

    /** 获取所有对话（按更新时间倒序） */
    getAll(): Conversation[] {
        return Array.from(this.conversations.values())
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** 添加消息到指定对话 */
    addMessage(convId: string, role: 'user' | 'assistant', content: string): ChatMessage | null {
        const conv = this.conversations.get(convId);
        if (!conv) return null;

        const msg: ChatMessage = {
            id: generateId(),
            role,
            content,
            timestamp: Date.now(),
        };
        conv.messages.push(msg);
        conv.updatedAt = Date.now();

        if (conv.title === '新对话' && role === 'user' && content.trim()) {
            conv.title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
        }

        this.persist().catch((err) => this.handlePersistError(err));
        return msg;
    }

    /** 更新指定消息内容（用于流式追加） */
    updateMessage(convId: string, msgId: string, content: string, skipSave = false): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        const msg = conv.messages.find(m => m.id === msgId);
        if (!msg) return false;
        msg.content = content;
        conv.updatedAt = Date.now();
        if (!skipSave) {
            this.persist().catch((err) => this.handlePersistError(err));
        }
        return true;
    }

    /** 更新指定消息的结构化 parts（思考 / 工具调用）。 */
    updateMessageParts(convId: string, msgId: string, parts: MessagePart[] | undefined, skipSave = false): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        const msg = conv.messages.find(m => m.id === msgId);
        if (!msg) return false;
        msg.parts = parts ? [...parts] : undefined;
        conv.updatedAt = Date.now();
        if (!skipSave) {
            this.persist().catch((err) => this.handlePersistError(err));
        }
        return true;
    }

    /**
     * 设置/清除分支注入转写（持久化在会话上：跨视图重载/重启不丢）。
     * 分支会话首条发送后传 undefined 清除。不更新 updatedAt——转写不是用户活动，不应改变排序。
     */
    setForkTranscript(convId: string, transcript: string | undefined): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        if (transcript === undefined) {
            delete conv.forkTranscript;
        } else {
            conv.forkTranscript = transcript;
        }
        this.persist().catch((err) => this.handlePersistError(err));
        return true;
    }

    /** 设置对话的 ACP sessionId */
    setSessionId(convId: string, sessionId: string): boolean {
        const conv = this.conversations.get(convId);
        if (!conv) return false;
        conv.sessionId = sessionId;
        return true;
    }
}
