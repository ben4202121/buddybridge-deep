// ==================== 发送队列（Phase 1.2） ====================
// 视图层 FIFO 缓冲：回复流式期间可继续输入，各会话独立队列。
// 纯内存、不持久化；由 chat 视图的队列泵 drain 消费。
//
// 甄别注记（相对参考 buddybridge）：
// 参考是「一消息一进程」，天然串行；Deep/ACP 是单进程多会话，
// AcpClient 按 session 保证单 in-flight（inflightSessions），因此「串行」
// 需在视图层用 draining Set 实现（见 chat.ts），本队列本身不感知。

import { generateId } from '../types';

export interface QueueItem {
    id: string;
    convId: string;
    text: string;
    /** 入队时的笔记快照（当前文件路径）；排队期间切笔记不影响本条消息携带的上下文。 */
    notePath: string | null;
}

export class SendQueue {
    private queues: Map<string, QueueItem[]> = new Map();

    /** FIFO 入队（按会话）；返回带唯一 id 的排队项。 */
    enqueue(convId: string, text: string, notePath: string | null): QueueItem {
        let list = this.queues.get(convId);
        if (!list) {
            list = [];
            this.queues.set(convId, list);
        }
        const item: QueueItem = { id: generateId(), convId, text, notePath };
        list.push(item);
        return item;
    }

    /** 查看指定会话队头（不出队）。 */
    peekFor(convId: string): QueueItem | null {
        const list = this.queues.get(convId);
        return list && list.length > 0 ? list[0] : null;
    }

    /** 出队指定会话队头；队列变空时删除会话键。 */
    dequeue(convId: string): QueueItem | null {
        const list = this.queues.get(convId);
        if (!list || list.length === 0) return null;
        const item = list.shift()!;
        if (list.length === 0) this.queues.delete(convId);
        return item;
    }

    /** 按 id 删除任意会话中的排队项（用于 chip ✕）。 */
    remove(id: string): boolean {
        for (const [convId, list] of this.queues) {
            const idx = list.findIndex(i => i.id === id);
            if (idx >= 0) {
                list.splice(idx, 1);
                if (list.length === 0) this.queues.delete(convId);
                return true;
            }
        }
        return false;
    }

    /** 原位编辑排队项文本（保持位置）。 */
    update(id: string, text: string): boolean {
        for (const list of this.queues.values()) {
            const item = list.find(i => i.id === id);
            if (item) {
                item.text = text;
                return true;
            }
        }
        return false;
    }

    /** 返回指定会话排队项的副本。 */
    listFor(convId: string): QueueItem[] {
        return [...(this.queues.get(convId) ?? [])];
    }

    /** 所有会话排队项总数。 */
    size(): number {
        let n = 0;
        for (const list of this.queues.values()) n += list.length;
        return n;
    }

    isEmpty(): boolean {
        return this.queues.size === 0;
    }
}
