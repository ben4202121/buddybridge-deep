// ==================== 分支（Phase 1.3） ====================
// 纯逻辑：从任一条消息「从这里继续新对话」，携带截至该消息的历史；
// 首条发送时把对话转写作为背景注入新 session。视图层负责 UI、守卫与渲染。

import type { ChatMessage } from '../types';

/** 提取截至指定消息的会话历史（含该消息本身）；消息不存在返回空数组。 */
export function buildForkHistory(messages: ChatMessage[], msgId: string): ChatMessage[] {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return [];
    return messages.slice(0, idx + 1);
}

/** 构建分支注入转写：截至分叉点的对话（角色标注），供新 session 作为背景参考。 */
export function buildForkTranscript(messages: ChatMessage[]): string {
    const lines: string[] = ['[系统注入·分支上下文] 以下是你与此用户此前的对话（截至分支点），仅作背景参考：'];
    for (const m of messages) {
        const content = m.content.trim();
        if (!content) continue;
        lines.push(`${m.role === 'user' ? '用户' : '助手'}: ${content}`);
    }
    return lines.join('\n');
}
