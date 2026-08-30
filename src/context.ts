// ==================== 当前文档感知 / 上下文注入 ====================
// 基于 buddybridge-main 的去重注入设计，扩展「注入当前笔记全文」（injectNoteContent）。

/** 注入当前笔记全文的最大字符数（防止超大笔记撑爆上下文）。 */
export const MAX_INJECTED_NOTE_CHARS = 30000;

export interface PromptContextInput {
    userText: string;
    /** 当前活动笔记路径（可为空） */
    notePath?: string | null;
    /** 当前活动笔记全文（可为空；仅在 injectNoteContent 开启时注入） */
    noteContent?: string | null;
    /** Vault 根路径（可为空） */
    vaultPath?: string | null;
    /** 是否注入当前笔记路径（设置项 noteLinkInjection） */
    noteLinkInjection: boolean;
    /** 是否注入 Vault 上下文（设置项 vaultContextInjection） */
    vaultContextInjection: boolean;
    /** 是否注入当前笔记全文（设置项 injectNoteContent） */
    injectNoteContent: boolean;
}

export interface PromptContextFlags {
    noteLinkInjection: boolean;
    vaultContextInjection: boolean;
    injectNoteContent: boolean;
}

/**
 * 构建发送给 ACP 的提示文本。
 * 设计要点：
 * - 默认只注入路径（避免撑爆上下文；Harness 有 fs 工具可自行读取 Vault）。
 * - 开启 injectNoteContent 时注入当前笔记全文（代码块包裹）。
 * - 注入文本只进入发送给 ACP 的 prompt，不写入对话历史。
 * - 未打开笔记/Vault 时跳过对应注入行；全部开关关闭时原样返回用户文本。
 */
export function buildPromptContext(input: PromptContextInput): string {
    const lines: string[] = [];
    if (input.noteLinkInjection && input.notePath) {
        lines.push(`[当前笔记: ${input.notePath}]`);
    }
    if (input.injectNoteContent && input.noteContent) {
        let content = input.noteContent;
        if (content.length > MAX_INJECTED_NOTE_CHARS) {
            content = content.substring(0, MAX_INJECTED_NOTE_CHARS) + '\n…（内容过长已截断）';
        }
        lines.push('```markdown');
        lines.push(content.replace(/```/g, '\\`\\`\\`'));
        lines.push('```');
    }
    if (input.vaultContextInjection && input.vaultPath) {
        lines.push(`[Vault: ${input.vaultPath}]`);
    }
    if (lines.length === 0) {
        return input.userText;
    }
    return lines.join('\n') + '\n\n' + input.userText;
}

/** 会话内已注入的上下文签名（去重用）。 */
export interface PromptContextState {
    notePath: string | null;
    noteContent: string | null;
    vaultPath: string | null;
}

/**
 * 会话内上下文去重：同一会话中，笔记路径 / 笔记全文 / Vault「没变化」就不再重复注入，
 * 只在变化时注入 → 避免 Harness 历史里堆叠重复的上下文行。
 *
 * - prev 为 null（本会话第一条消息）：始终注入完整当前上下文。
 * - 上下文与 prev 相同：原样返回用户文本（不注入）。
 * - 笔记由非空变为空：前置 `[当前笔记: 无]`，告知 agent 不再沿用旧笔记。
 *
 * @returns 实际发送的文本 + 本轮应记录的最新 state（供调用方回写缓存）。
 */
export function buildDedupedPrompt(
    prev: PromptContextState | null,
    current: PromptContextState,
    userText: string,
    flags: PromptContextFlags,
): { text: string; state: PromptContextState } {
    const same = prev
        && prev.notePath === current.notePath
        && prev.noteContent === current.noteContent
        && prev.vaultPath === current.vaultPath;
    if (same) {
        return { text: userText, state: current };
    }

    let text = buildPromptContext({
        userText,
        notePath: current.notePath,
        noteContent: flags.injectNoteContent ? current.noteContent : null,
        vaultPath: current.vaultPath,
        noteLinkInjection: flags.noteLinkInjection,
        vaultContextInjection: flags.vaultContextInjection,
        injectNoteContent: flags.injectNoteContent,
    });

    // 笔记由非空变为空：显式告知「无笔记」，防止 agent 继续按旧笔记行动
    if (flags.noteLinkInjection && prev?.notePath && !current.notePath) {
        text = `[当前笔记: 无]\n\n${text}`;
    }

    return { text, state: current };
}
