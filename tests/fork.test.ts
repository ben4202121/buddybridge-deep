import { buildForkHistory, buildForkTranscript } from '../src/chat/fork';
import type { ChatMessage } from '../src/types';

function msg(id: string, role: 'user' | 'assistant', content: string, timestamp = 1): ChatMessage {
    return { id, role, content, timestamp };
}

describe('buildForkHistory', () => {
    it('slices history up to and including the target message', () => {
        const msgs = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c')];
        expect(buildForkHistory(msgs, '2').map(m => m.id)).toEqual(['1', '2']);
        expect(buildForkHistory(msgs, '1').map(m => m.id)).toEqual(['1']);
        expect(buildForkHistory(msgs, '3').map(m => m.id)).toEqual(['1', '2', '3']);
    });

    it('returns empty array when message not found or empty input', () => {
        const msgs = [msg('1', 'user', 'a')];
        expect(buildForkHistory(msgs, 'nope')).toEqual([]);
        expect(buildForkHistory([], '1')).toEqual([]);
    });
});

describe('buildForkTranscript', () => {
    it('builds header + role-labeled lines, skipping blank content', () => {
        const msgs = [
            msg('1', 'user', '你好'),
            msg('2', 'assistant', '   '),
            msg('3', 'assistant', '世界'),
        ];
        const t = buildForkTranscript(msgs);
        expect(t).toContain('[系统注入·分支上下文]');
        expect(t).toContain('用户: 你好');
        expect(t).toContain('助手: 世界');
        expect(t).not.toContain('助手:  ');
    });

    it('returns just the header for empty input', () => {
        expect(buildForkTranscript([])).toBe(
            '[系统注入·分支上下文] 以下是你与此用户此前的对话（截至分支点），仅作背景参考：'
        );
    });
});
