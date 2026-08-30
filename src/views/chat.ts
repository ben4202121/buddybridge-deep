import { ItemView, Notice, MarkdownRenderer, Component, setIcon, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { ConversationManager } from '../chat/manager';
import { SendQueue, type QueueItem } from '../chat/queue';
import { buildForkHistory, buildForkTranscript } from '../chat/fork';
import { getErrorMessage, type Conversation, type ChatMessage, type MessagePart, type BuddyBridgeSettings } from '../types';
import { buildDedupedPrompt, MAX_INJECTED_NOTE_CHARS, type PromptContextState } from '../context';
import type { VaultContext } from '../core/bridge-adapter';
import type { StreamUsage } from '../core/stream-chunk';
import { t, friendlyError } from '../i18n';
import type BuddyBridgePlugin from '../main';

export const VIEW_TYPE_CHAT = "buddybridge-deep-panel";

export class BuddyBridgeChatView extends ItemView {
    private plugin: BuddyBridgePlugin;
    private manager: ConversationManager;
    private messageContainer!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtn!: HTMLButtonElement;
    private tabBar!: HTMLElement;
    private currentFileBar!: HTMLElement;
    /** 各会话当前流式中的 assistant 消息 id（convId → msgId）；多会话各自一条流，互不串窗。 */
    private streamingMsgIds = new Map<string, string>();
    /** 各会话的停止请求（convId）：只影响该会话当前这条流，队列保留继续。 */
    private stopRequests = new Set<string>();
    /** 发送队列：流式期间可继续输入，FIFO 串行发送（纯视图层，不持久化）。 */
    private sendQueue: SendQueue = new SendQueue();
    /** 正在被队列泵 drain 的会话集合（convId）；各会话可并发 drain（独立 ACP session），同会话防重入。 */
    private draining = new Set<string>();
    /** 各会话「取消落定」屏障（convId → Promise）：停止当前条后，drain 下一条须等取消彻底结束，
     * 避免同 ACP session 复用时的 in-flight 竞态（下一条 prompt 撞上未清理的流/标记）。 */
    private cancelBarriers = new Map<string, Promise<void>>();
    private queueBar!: HTMLElement;
    private markdownComponent: Component;
    private fileIndex: { paths: Map<string, string>; basenames: Map<string, string[]> } | null = null;
    private fileIndexBuiltAt = 0;
    private loadDataCallback: () => Promise<Conversation[]>;
    /** 会话内已注入的上下文签名（去重用，内存态） */
    private contextStates = new Map<string, PromptContextState>();
    /** 各会话 session 创建时的连接代际（convId → adapter.getEpoch()）。进程重启后代际变化 → 旧 session 失效需新建（2.1）。 */
    private sessionEpochs = new Map<string, number>();
    /**
     * 当前活动笔记路径（last active file）。由 active-leaf-change 事件维护；
     * 不直接调 getActiveFile()——焦点在聊天面板（ItemView 无文件）时它返回不可靠。
     * 入队时快照到 QueueItem.notePath，排队期间切笔记不影响该条消息。
     */
    private currentFilePath: string | null = null;
    /** 各会话附加文件（convId → [{path, content}]，3.2；内存态不持久化，随视图关闭丢弃）。 */
    private attachedFiles = new Map<string, Array<{ path: string; content: string }>>();
    /** 顶部附加文件 chip 条（3.2，仅显示当前会话）。 */
    private attachBar!: HTMLElement;
    /** 各会话最近一次回复的 token 用量（convId → usage，3.1；done chunk 更新，随会话删除/清空）。 */
    private usageByConv = new Map<string, StreamUsage | null>();
    /** 输入区旁的用量指示元素（环形进度 + 计数，3.1）。 */
    private usageMeter: HTMLElement | null = null;
    private usageRing: HTMLElement | null = null;
    private usageText: HTMLElement | null = null;
    /** 上下文窗口估算（DeepSeek 默认 128k）；环形百分比 = total / window，仅供用量参考。 */
    private static readonly CONTEXT_WINDOW = 131072;

    constructor(leaf: WorkspaceLeaf, plugin: BuddyBridgePlugin, loadDataCallback: () => Promise<Conversation[]>) {
        super(leaf);
        this.plugin = plugin;
        this.loadDataCallback = loadDataCallback;
        this.manager = new ConversationManager();
        // markdownComponent 在 onOpen 时 load、onClose 时 unload（S8：生命周期随视图开关）
        this.markdownComponent = new Component();
    }

    getViewType(): string { return VIEW_TYPE_CHAT; }
    getDisplayText(): string { return t('ribbon.chat'); }
    getIcon(): string { return "bot"; }

    getManager(): ConversationManager { return this.manager; }

    /** 读取插件设置（用于上下文注入开关等）。 */
    private get pluginSettings(): Partial<BuddyBridgeSettings> | undefined {
        try {
            return (this.app as any).plugins?.plugins?.['buddybridge-deep']?.settings as Partial<BuddyBridgeSettings> | undefined;
        } catch {
            return undefined;
        }
    }

    private get vaultPath(): string | undefined {
        const adapter = this.app.vault.adapter as { basePath?: string };
        return adapter.basePath;
    }

    /**
     * 构建发送给 ACP 的上下文文本：会话内去重。
     * 笔记 / 笔记全文 / Vault 上下文「没变化」就不再重复注入。
     * @param notePath 入队时记录的笔记快照（严格：只认该快照，为空或文件已删除 → 不注入，
     *                 不回落实时活动文件，保证排队期间切笔记不影响本条消息）。
     */
    private async buildContextText(convId: string, text: string, notePath: string | null): Promise<string> {
        const settings = this.pluginSettings;
        const noteLink = settings?.noteLinkInjection !== false;
        const vaultCtx = !!settings?.vaultContextInjection;
        const injectContent = !!settings?.injectNoteContent;

        const snapshotPath = notePath;
        let file: TFile | null = null;
        if (snapshotPath) {
            const abs = this.app.vault.getAbstractFileByPath(snapshotPath);
            if (abs instanceof TFile) file = abs;
        }
        const notePathValue = noteLink ? (file?.path ?? null) : null;
        let noteContent: string | null = null;
        if (injectContent && file) {
            try {
                noteContent = await this.app.vault.read(file);
            } catch {
                noteContent = null;
            }
        }
        const current: PromptContextState = {
            notePath: notePathValue,
            noteContent,
            vaultPath: vaultCtx ? (this.vaultPath ?? null) : null,
        };
        const prev = this.contextStates.get(convId) ?? null;
        const { text: out, state } = buildDedupedPrompt(prev, current, text, {
            noteLinkInjection: noteLink,
            vaultContextInjection: vaultCtx,
            injectNoteContent: injectContent,
        });
        this.contextStates.set(convId, state);
        return out;
    }

    async onOpen() {
        // 单实例守卫（1.6）：传输层共享同一 adapter/持久化，多个聊天窗口各自持有独立
        // manager 与队列，同时打开会互相踩掉流式状态与持久化（多窗口互踩 → 卡死/串窗）。
        // 新窗口打开时关闭其他聊天 leaf（其 onClose 会取消各自在途流），只保留当前这一个。
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
        for (const leaf of leaves) {
            if (leaf !== this.leaf) {
                await leaf.detach();
            }
        }

        const container = this.contentEl;
        container.empty();
        container.addClass('buddybridge-chat-container');

        // 应用自定义主色调
        try {
            const plugin = (this.app as any).plugins?.plugins?.['buddybridge-deep'];
            if (plugin?.applyPrimaryColor) {
                plugin.applyPrimaryColor();
            }
        } catch (e) {
            console.error('[BD] 应用主色调失败:', e);
        }

        // 顶部标签栏
        this.tabBar = container.createDiv({ cls: 'buddybridge-tab-bar' });
        const newBtn = this.tabBar.createEl('button', {
            text: '',
            cls: 'buddybridge-new-chat-btn',
            attr: { title: t('chat.newChat'), 'aria-label': t('chat.newChat') }
        });
        setIcon(newBtn, 'plus');
        newBtn.onclick = () => this.createNewChat();

        // 当前文件指示器
        this.currentFileBar = container.createDiv({ cls: 'buddybridge-current-file' });
        this.currentFilePath = this.app.workspace.getActiveFile()?.path ?? null;
        this.updateCurrentFileBar();
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                const file = this.app.workspace.getActiveFile();
                // 焦点移到非文件视图（聊天面板等）时保留最后查看的笔记，不置空——
                // 否则点一下聊天面板，当前文章感知就丢了（buildContextText 也读这里）
                if (file) {
                    this.currentFilePath = file.path;
                }
                this.updateCurrentFileBar();
            })
        );

        // 附加文件 chip 条（3.2）：仅显示当前会话的附加笔记，可 ✕ 移除
        this.attachBar = container.createDiv({ cls: 'buddybridge-attach-bar buddybridge-hidden' });

        // 文件右键菜单：附加到当前会话上下文（3.2，读全文注入）
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile)) return;
                if (!this.manager.getActive()) return;
                menu.addItem((item) => {
                    item.setTitle(t('chat.attachToConv'))
                        .setIcon('paperclip')
                        .onClick(() => void this.attachNoteToContext(file));
                });
            })
        );

        // 消息区域
        this.messageContainer = container.createDiv({ cls: 'buddybridge-messages' });

        // 发送队列条（排队中消息，可删除/内联编辑）
        this.queueBar = container.createDiv({ cls: 'buddybridge-queue-bar buddybridge-hidden' });

        // 上下文用量指示（3.1）：最近一次回复的 token 环形 + 计数；初始隐藏，收到 done 后显示
        this.usageMeter = container.createDiv({ cls: 'buddybridge-usage-meter buddybridge-hidden' });
        this.usageRing = this.usageMeter.createDiv({ cls: 'buddybridge-usage-ring', attr: { title: t('chat.usageTitle') } });
        this.usageText = this.usageMeter.createSpan({ cls: 'buddybridge-usage-text' });
        this.updateUsageMeter();

        // 底部输入区
        const inputArea = container.createDiv({ cls: 'buddybridge-input-area' });
        this.inputEl = inputArea.createEl('textarea', {
            cls: 'buddybridge-input',
            attr: { placeholder: t('chat.placeholder'), rows: '2' }
        });
        this.inputEl.onkeydown = (e) => this.handleKeydown(e);
        this.inputEl.oninput = () => this.adjustTextareaHeight();

        this.sendBtn = inputArea.createEl('button', {
            text: t('chat.send'),
            cls: 'buddybridge-send-btn',
            attr: { 'aria-label': t('chat.send') }
        });
        this.sendBtn.onclick = () => {
            const conv = this.manager.getActive();
            if (conv && this.draining.has(conv.id)) {
                this.stopStreaming();
            } else {
                void this.sendMessage();
            }
        };

        // 从插件设置同步最大对话数
        try {
            const plugin = (this.app as any).plugins?.plugins?.['buddybridge-deep'];
            if (plugin?.settings?.maxConversations) {
                this.manager.setMaxConversations(plugin.settings.maxConversations);
            }
        } catch (e) {
            console.error('[BD] 同步最大对话数失败:', e);
        }

        this.markdownComponent.load();

        // DOM 构建完成后加载历史对话
        try {
            const conversations = await this.loadDataCallback();
            await this.loadConversations(conversations);
        } catch (e) {
            console.error('[BD] 加载历史对话失败:', e);
        }

        // 队列条初始为空（不持久化），泵用于兜底恢复被打断的 drain
        this.renderQueueBar();
        void this.pumpQueue();
    }

    async onClose() {
        // S1：关闭视图时终止进行中的流式请求、队列 drain 与排队项并落盘，
        // 避免旧视图的持久化覆盖新数据、避免面板关闭后排队项仍在后台被发送（面板关闭即弃）
        for (const conv of this.manager.getAll()) {
            if (conv.sessionId && this.streamingMsgIds.has(conv.id)) {
                void this.plugin.cancelSession(conv.sessionId);
            }
        }
        // 停止队列泵：清空排队项与 drain/停止/屏障标记（仍在途的 processItem 由取消后的流终止收敛）
        this.sendQueue = new SendQueue();
        this.draining.clear();
        this.cancelBarriers.clear();
        this.stopRequests.clear();
        this.streamingMsgIds.clear();
        try {
            await this.manager.flush();
        } catch (e) {
            console.error('[BD] onClose flush failed:', e);
        }
        this.markdownComponent.unload();
    }

    async loadConversations(conversations: Conversation[]) {
        this.manager.load(conversations);
        this.renderTabs();
        await this.renderMessages();
    }

    private async createNewChat() {
        // 方向 A（1.4）：达上限禁止新建并提示（守卫内部提示「对话已满」）
        if (this.atConversationLimit()) return;
        this.manager.createConversation();
        this.renderTabs();
        await this.renderMessages();
        this.updateSendButton();
        this.renderQueueBar();
        // 3.1：新会话无用量记录（usageByConv 无条目），指示复位隐藏
        this.updateUsageMeter();
        // 3.2：新会话无附加文件，刷新 chip 条（隐藏）
        this.renderAttachBar();
    }

    /** 会话上限守卫：达到上限时提示并返回 true（调用方应中止新建）。 */
    private atConversationLimit(): boolean {
        const max = this.manager.getMaxConversations();
        if (this.manager.atMaxConversations()) {
            new Notice(t('chat.convFull', { max }));
            return true;
        }
        return false;
    }

    /** 分支：从指定消息「从这里继续新对话」，复制截至该消息的历史到新会话。 */
    private forkFrom(msg: ChatMessage): void {
        const conv = this.manager.getActive();
        if (!conv) return;
        const history = buildForkHistory(conv.messages, msg.id);
        if (history.length === 0) return;
        // 分叉即新建会话：达上限时被拦截并提示（守卫内部提示「对话已满」）
        if (this.atConversationLimit()) return;

        const newConv = this.manager.createConversation(`${conv.title}（分支）`);
        this.manager.replaceMessages(newConv.id, history);
        // 分叉上下文一次性注入：转写持久化在会话上（跨视图重载/重启不丢），首条发送时读取即清除
        this.manager.setForkTranscript(newConv.id, buildForkTranscript(history));

        this.renderTabs();
        void this.renderMessages();
        this.updateSendButton();
        this.renderQueueBar();
        // 3.2：分叉后是全新空会话，chip 条复位（不显示源会话的附加文件）
        this.renderAttachBar();
    }

    private async switchToChat(id: string) {
        this.manager.switchTo(id);
        this.renderTabs();
        await this.renderMessages();
        // 输入框始终可用（队列模型：流式期间也可继续输入），仅更新按钮状态
        this.updateSendButton();
        // 立即按新会话重渲染队列条（各会话队列独立，只显示当前会话的等待项）
        this.renderQueueBar();
        // 切回有排队项的会话时立即恢复处理
        void this.pumpQueue();
        // 3.2：按新会话重渲染附加文件 chip 条（各会话附加列表独立）
        this.renderAttachBar();
        // 3.1 修复：用量指示按会话显示（切换后显示目标会话的用量，无则隐藏）
        this.updateUsageMeter();
    }

    private async deleteChat(id: string, e: UIEvent) {
        e.stopPropagation();
        // 若删除的是正在流式的会话：取消其 ACP 请求并清理流式状态
        const conv = this.manager.getConversation(id);
        if (conv?.sessionId && this.streamingMsgIds.has(id)) {
            this.plugin.cancelSession(conv.sessionId);
        }
        this.streamingMsgIds.delete(id);
        this.stopRequests.delete(id);
        this.sessionEpochs.delete(id);
        // 分支转写随会话一起删除（持久化在会话上，无需单独清理）
        this.manager.deleteConversation(id);
        // 清理该会话残留的排队项（孤儿项不会发送，留在内存里浪费）
        this.clearQueuedFor(id);
        // 3.2：删除会话时清理其附加文件（内存态，随会话丢弃）
        this.attachedFiles.delete(id);
        // 3.1 修复：同步清理该会话用量记录，并复位指示（当前活动已切到其他会话）
        this.usageByConv.delete(id);
        this.renderTabs();
        await this.renderMessages();
        this.updateSendButton();
        this.renderAttachBar();
        this.updateUsageMeter();
    }

    /** 清空当前对话（/clear 语义）：取消在途流、丢弃排队项、重置消息/sessionId，下一条换新 session。 */
    async clearConversation(): Promise<void> {
        const conv = this.manager.getActive();
        if (!conv) return;
        // 取消该会话在途流并清理流式/停止标记（sessionId 即将重置，旧流作废）
        if (conv.sessionId && this.streamingMsgIds.has(conv.id)) {
            void this.plugin.cancelSession(conv.sessionId);
        }
        this.streamingMsgIds.delete(conv.id);
        this.stopRequests.delete(conv.id);
        this.sessionEpochs.delete(conv.id);
        // 丢弃排队项
        this.clearQueuedFor(conv.id);
        this.manager.clearConversation(conv.id);
        // 上下文去重状态重置：清空后下一条消息重新注入当前笔记等上下文
        this.contextStates.delete(conv.id);
        // 3.2：清空对话同时移除其附加文件（语义一致：内容清空）
        this.attachedFiles.delete(conv.id);
        // 3.1 修复：清空后 sessionId 即将重置，旧用量作废，指示复位隐藏
        this.usageByConv.set(conv.id, null);
        this.renderTabs();
        await this.renderMessages();
        this.updateSendButton();
        this.renderQueueBar();
        this.renderAttachBar();
        this.updateUsageMeter();
    }

    /** 清空指定会话的全部排队项（删除会话时调用）。 */
    private clearQueuedFor(convId: string): void {
        for (const item of this.sendQueue.listFor(convId)) {
            this.sendQueue.remove(item.id);
        }
        this.renderQueueBar();
    }

    /** 渲染标签栏 */
    renderTabs() {
        const newBtn = this.tabBar.querySelector('.buddybridge-new-chat-btn');
        const oldTabs = this.tabBar.querySelectorAll('.buddybridge-tab');
        oldTabs.forEach(t => t.remove());

        const conversations = this.manager.getAll();
        const activeId = this.manager.getActive()?.id;

        for (const conv of conversations) {
            const tab = this.tabBar.createDiv({ cls: 'buddybridge-tab' });
            if (conv.id === activeId) {
                tab.addClass('buddybridge-tab-active');
            }
            tab.createSpan({ text: conv.title, cls: 'buddybridge-tab-title' });
            const closeBtn = tab.createSpan({
                cls: 'buddybridge-tab-close',
                attr: { title: t('chat.closeConv'), 'aria-label': t('chat.closeConv'), role: 'button', tabindex: '0' }
            });
            setIcon(closeBtn, 'x');
            closeBtn.onclick = (e: MouseEvent) => this.deleteChat(conv.id, e);
            closeBtn.onkeydown = (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void this.deleteChat(conv.id, e);
                }
            };
            tab.onclick = () => this.switchToChat(conv.id);

            if (newBtn) {
                tab.after(newBtn);
            }
        }
    }

    async renderMessages() {
        this.messageContainer.empty();
        const conv = this.manager.getActive();
        if (!conv) {
            const empty = this.messageContainer.createDiv({ cls: 'buddybridge-empty-chat' });
            const icon = empty.createDiv({ cls: 'buddybridge-empty-chat-icon' });
            setIcon(icon, 'message-square');
            empty.createDiv({ cls: 'buddybridge-empty-chat-title', text: t('chat.emptyTitle') });
            empty.createDiv({ cls: 'buddybridge-empty-chat-subtitle', text: t('chat.emptySubtitle') });

            const tips = empty.createDiv({ cls: 'buddybridge-empty-chat-tips' });
            tips.createDiv({ text: t('chat.tipTitle') });
            const tipList = tips.createEl('ul');
            const tipItems = [
                t('chat.tipEnter'),
                t('chat.tipMultiTurn'),
                t('chat.tipSetup'),
            ];
            for (const tip of tipItems) {
                tipList.createEl('li', { text: tip });
            }
            return;
        }

        for (const msg of conv.messages) {
            // S4：重试按钮仅对「最后一条消息」有效，避免点击旧错误卡误删/误发最新一轮
            const isLast = conv.messages[conv.messages.length - 1]?.id === msg.id;
            await this.renderMessage(msg, conv.id, isLast ? () => this.retryLastExchange() : undefined);
        }

        this.scrollToBottom();
    }

    private async renderMessage(msg: ChatMessage, convId: string, onRetry?: () => void) {
        const row = this.messageContainer.createDiv({
            cls: `buddybridge-message-row buddybridge-message-${msg.role}`,
            // data-msg-id：供流式增量定位气泡（精确匹配，不依赖 :last-child 顺序）
            attr: { 'data-msg-id': msg.id }
        });
        const isWaiting = msg.role === 'assistant' && msg.content === '' && msg.id === this.streamingMsgIds.get(convId);
        // 分支入口（Phase 1.3）：悬浮按钮 → 从这里继续新对话（复制截至该消息的历史）。
        // 流式占位行不提供——空/不完整回复不该被复制进分叉；回复完成后重渲染即出现。
        if (!isWaiting) {
            const forkBtn = row.createDiv({
                cls: 'buddybridge-fork-btn',
                attr: { title: t('chat.forkFrom'), 'aria-label': t('chat.forkFrom'), role: 'button', tabindex: '0' }
            });
            setIcon(forkBtn, 'git-branch');
            forkBtn.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                this.forkFrom(msg);
            };
            forkBtn.onkeydown = (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.forkFrom(msg);
                }
            };
        }
        const bubble = row.createDiv({ cls: 'buddybridge-bubble' });

        if (isWaiting) {
            this.renderThinkingIndicator(bubble);
        } else if (msg.role === 'assistant') {
            if (msg.content.startsWith('错误:') || msg.content.startsWith('Error:')) {
                this.renderErrorCard(bubble, msg.content, onRetry);
            } else {
                if (msg.parts && msg.parts.length > 0) {
                    this.renderMessageParts(bubble, msg.parts);
                }
                await this.renderMarkdownContent(bubble, msg.content);
            }
        } else {
            bubble.createSpan({ text: msg.content });
        }
        return row;
    }

    /** 从持久化的 parts 重建思考块与工具卡。 */
    private renderMessageParts(bubble: HTMLElement, parts: MessagePart[]): void {
        let toolsBlock: HTMLElement | null = null;
        for (const part of parts) {
            if (part.kind === 'thinking') {
                this.renderThinkingBlock(bubble, part.content || '', t('chat.thought'));
            } else if (part.kind === 'tool') {
                if (!toolsBlock) {
                    toolsBlock = this.renderToolsBlock(bubble);
                }
                this.appendToolRow(toolsBlock, part.name || '', part.detail || '');
            }
        }
    }

    private renderThinkingBlock(bubble: HTMLElement, content: string, label: string): HTMLElement {
        let block = bubble.querySelector('.buddybridge-thinking-block') as HTMLElement | null;
        if (!block) {
            block = bubble.createDiv({ cls: 'buddybridge-thinking-block' });
            const header = block.createDiv({ cls: 'buddybridge-thinking-header' });
            const icon = header.createSpan({ cls: 'buddybridge-thinking-header-icon' });
            setIcon(icon, 'sparkles');
            header.createSpan({ cls: 'buddybridge-thinking-header-text', text: label });
            const chevron = header.createSpan({ cls: 'buddybridge-thinking-header-chevron', text: '▾' });
            const bodyDiv = block.createDiv({ cls: 'buddybridge-thinking-body buddybridge-hidden' });
            header.addEventListener('click', () => {
                const hidden = bodyDiv.hasClass('buddybridge-hidden');
                bodyDiv.toggleClass('buddybridge-hidden', !hidden);
                chevron.textContent = hidden ? '▾' : '▸';
            });
        }
        const headerText = block.querySelector('.buddybridge-thinking-header-text');
        if (headerText instanceof HTMLElement) {
            headerText.setText(label);
        }
        const body = block.querySelector('.buddybridge-thinking-body');
        if (body instanceof HTMLElement) {
            body.setText(content);
        }
        return block;
    }

    private renderToolsBlock(bubble: HTMLElement): HTMLElement {
        let toolsBlock = bubble.querySelector('.buddybridge-tools-block') as HTMLElement | null;
        if (!toolsBlock) {
            toolsBlock = bubble.createDiv({ cls: 'buddybridge-tools-block' });
            const hdr = toolsBlock.createDiv({ cls: 'buddybridge-tools-header' });
            const icon = hdr.createSpan({ cls: 'buddybridge-tools-header-icon' });
            setIcon(icon, 'wrench');
            hdr.createSpan({ cls: 'buddybridge-tools-header-text', text: t('chat.toolCalls') });
            const chevron = hdr.createSpan({ cls: 'buddybridge-tools-header-chevron', text: '▾' });
            hdr.addEventListener('click', () => {
                const list = toolsBlock.querySelector('.buddybridge-tools-list');
                if (list instanceof HTMLElement) {
                    const hidden = list.hasClass('buddybridge-hidden');
                    list.toggleClass('buddybridge-hidden', !hidden);
                    chevron.textContent = hidden ? '▾' : '▸';
                }
            });
            toolsBlock.createDiv({ cls: 'buddybridge-tools-list buddybridge-hidden' });
        }
        return toolsBlock;
    }

    private appendToolRow(toolsBlock: HTMLElement, toolName: string, toolDetail: string): void {
        const list = toolsBlock.querySelector('.buddybridge-tools-list');
        if (!(list instanceof HTMLElement)) return;
        let iconName = 'wrench';
        if (toolName.includes('read') || toolName.includes('查看') || toolName.includes('读取')) {
            iconName = 'file-text';
        } else if (toolName.includes('write') || toolName.includes('编辑') || toolName.includes('写入')) {
            iconName = 'pencil';
        } else if (toolName.includes('search') || toolName.includes('搜索') || toolName.includes('查找')) {
            iconName = 'search';
        }
        const row = list.createDiv({ cls: 'buddybridge-tool-call' });
        const icon = row.createSpan({ cls: 'buddybridge-tool-call-icon' });
        setIcon(icon, iconName);
        row.createSpan({
            cls: 'buddybridge-tool-call-text',
            text: `${toolName} ${toolDetail}`.trim()
        });
    }

    /** 错误卡「重试」：删除最近一对 user+assistant 消息，将 user 放回输入框并重发。 */
    private retryLastExchange(): void {
        const conv = this.manager.getActive();
        if (!conv || conv.messages.length === 0) return;

        let lastUserIdx = -1;
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) return;

        const userMsg = conv.messages[lastUserIdx];
        const idsToRemove = conv.messages.slice(lastUserIdx).map(m => m.id);
        this.manager.removeMessages(conv.id, idsToRemove);

        this.inputEl.value = userMsg.content;
        this.adjustTextareaHeight();
        void this.renderMessages();
        void this.sendMessage();
    }

    private renderErrorCard(bubble: HTMLElement, content: string, onRetry?: () => void) {
        const card = bubble.createDiv({ cls: 'buddybridge-error-card' });
        const icon = card.createDiv({ cls: 'buddybridge-error-card-icon' });
        setIcon(icon, 'alert-triangle');

        const errorMsg = content.replace(/^错误:\s*/, '').replace(/^Error:\s*/, '');
        card.createDiv({ cls: 'buddybridge-error-card-title', text: t('chat.requestFailTitle') });
        card.createDiv({ cls: 'buddybridge-error-card-body', text: errorMsg });

        const hint = this.getErrorHint(errorMsg);
        if (hint) {
            card.createDiv({ cls: 'buddybridge-error-card-hint', text: hint });
        }

        if (onRetry) {
            const actions = card.createDiv({ cls: 'buddybridge-error-card-actions' });
            const retryBtn = actions.createEl('button', {
                text: t('chat.retry'),
                cls: 'mod-cta buddybridge-error-retry-btn',
                attr: { 'aria-label': t('chat.retryAria') }
            });
            retryBtn.onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onRetry();
            };
        }
    }

    private getErrorHint(errorMsg: string): string | null {
        if (errorMsg.includes('DSH') || errorMsg.includes('dsh') || errorMsg.includes('ACP') || errorMsg.includes('profile acp')) {
            return t('chat.errHintConfig');
        }
        if (errorMsg.includes('timeout') || errorMsg.includes('超时') || errorMsg.includes('TIMEOUT')) {
            return t('chat.errHintTimeout');
        }
        return null;
    }

    private renderThinkingIndicator(bubble: HTMLElement) {
        const thinking = bubble.createDiv({ cls: 'buddybridge-thinking' });
        thinking.createSpan({ cls: 'buddybridge-thinking-text', text: t('chat.thinking') });
        const dots = thinking.createDiv({ cls: 'buddybridge-thinking-dots' });
        for (let i = 0; i < 3; i++) {
            dots.createSpan({ cls: 'buddybridge-dot' });
        }
    }

    private async renderMarkdownContent(bubble: HTMLElement, content: string): Promise<void> {
        if (!content) return;

        const thinkingBlock = bubble.querySelector('.buddybridge-thinking-block');
        const toolsBlock = bubble.querySelector('.buddybridge-tools-block');

        let markdownContainer = bubble.querySelector('.buddybridge-markdown-content');
        if (!(markdownContainer instanceof HTMLElement)) {
            markdownContainer = bubble.createDiv({ cls: 'buddybridge-markdown-content' });
            if (thinkingBlock instanceof HTMLElement) {
                bubble.insertBefore(markdownContainer, thinkingBlock);
            } else if (toolsBlock instanceof HTMLElement) {
                bubble.insertBefore(markdownContainer, toolsBlock);
            }
        }

        if (!(markdownContainer instanceof HTMLElement)) return;

        markdownContainer.empty();

        await MarkdownRenderer.render(
            this.app,
            content,
            markdownContainer,
            '',
            this.markdownComponent
        );

        this.linkFileReferences(markdownContainer);
    }

    /** 构建/复用 vault 文件索引（带过期时间）。 */
    private getFileIndex(): { paths: Map<string, string>; basenames: Map<string, string[]> } {
        const now = Date.now();
        if (this.fileIndex && now - this.fileIndexBuiltAt < 10000) {
            return this.fileIndex;
        }
        const paths = new Map<string, string>();
        const basenames = new Map<string, string[]>();
        for (const file of this.app.vault.getFiles()) {
            const normalized = file.path.toLowerCase().replace(/\\/g, '/');
            paths.set(normalized, file.path);
            const key = (file.basename + '.' + file.extension).toLowerCase();
            const list = basenames.get(key);
            if (list) {
                list.push(file.path);
            } else {
                basenames.set(key, [file.path]);
            }
        }
        this.fileIndex = { paths, basenames };
        this.fileIndexBuiltAt = now;
        return this.fileIndex;
    }

    private linkFileReferences(container: HTMLElement): void {
        const index = this.getFileIndex();
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node: Node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    if (parent.closest('a')) return NodeFilter.FILTER_REJECT;
                    if (parent.closest('pre')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                },
            }
        );
        const textNodes: Text[] = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode as Text);
        }
        for (const node of textNodes) {
            this.linkTextNode(node, index);
        }
    }

    private resolveFilePath(token: string, index: { paths: Map<string, string>; basenames: Map<string, string[]> }): string | null {
        const normalized = token.toLowerCase().replace(/\\/g, '/');
        const full = index.paths.get(normalized);
        if (full) return full;
        const sep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
        const base = sep >= 0 ? normalized.slice(sep + 1) : normalized;
        const list = index.basenames.get(base);
        if (list && list.length === 1) return list[0];
        return null;
    }

    private linkTextNode(node: Text, index: { paths: Map<string, string>; basenames: Map<string, string[]> }): void {
        const raw = node.nodeValue || '';
        if (!raw) return;

        const re = /[\u4e00-\u9fff\u3400-\u4dbf\w./\\-]+/g;
        const matches: { start: number; end: number; path: string }[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
            const token = m[0].replace(/[.,;:!?)\]}>'"。，；：！？）】》’"」》]+$/, '');
            if (!token) continue;
            const resolved = this.resolveFilePath(token, index);
            if (resolved) {
                matches.push({ start: m.index, end: m.index + token.length, path: resolved });
            }
        }
        if (matches.length === 0) return;

        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const match of matches) {
            if (match.start > cursor) {
                frag.append(document.createTextNode(raw.slice(cursor, match.start)));
            }
            const link = document.createElement('a');
            link.addClass('internal-link');
            link.setAttribute('data-href', match.path);
            link.setAttribute('href', match.path);
            link.textContent = raw.slice(match.start, match.end);
            link.addEventListener('click', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                void this.app.workspace.openLinkText(match.path, '');
            });
            frag.append(link);
            cursor = match.end;
        }
        if (cursor < raw.length) {
            frag.append(document.createTextNode(raw.slice(cursor)));
        }
        node.parentNode?.replaceChild(frag, node);
    }

    private adjustTextareaHeight() {
        this.inputEl.style.setProperty('--buddybridge-input-height', `${this.inputEl.scrollHeight}px`);
    }

    /** 更新发送按钮状态：当前活动会话正被队列 drain 时显示「停止」（只中断该会话的流，队列保留），否则「发送」。 */
    private updateSendButton() {
        this.inputEl.disabled = false; // 流式期间输入框保持可用（排队核心）
        const activeId = this.manager.getActive()?.id ?? null;
        const busy = activeId !== null && this.draining.has(activeId);
        this.sendBtn.setText(busy ? t('chat.stop') : t('chat.send'));
        this.sendBtn.setAttribute('aria-label', busy ? t('chat.stop') : t('chat.send'));
        this.sendBtn.toggleClass('buddybridge-send-btn-stop', busy);
    }

    /**
     * 语言切换后刷新静态 UI 文案（3.3 修复：打开中的面板立即换语言，无需重载插件）。
     * 由 plugin.applyLanguageUi() 调用；只更新固定 chrome（placeholder/按钮/提示/空状态），
     * 消息内容按持久化语言保留（错误卡双语正则已兼容），不整体重渲染以免打断在途流。
     */
    refreshUi(): void {
        if (this.inputEl) {
            this.inputEl.setAttribute('placeholder', t('chat.placeholder'));
        }
        this.updateSendButton(); // 发送/停止文字 + aria-label
        if (this.tabBar) {
            const newBtn = this.tabBar.querySelector('.buddybridge-new-chat-btn');
            if (newBtn) {
                newBtn.setAttribute('title', t('chat.newChat'));
                newBtn.setAttribute('aria-label', t('chat.newChat'));
            }
        }
        if (this.usageRing) {
            this.usageRing.setAttribute('title', t('chat.usageTitle'));
        }
        this.renderTabs(); // 关闭按钮 title/aria 随语言刷新
        this.renderAttachBar(); // chip ✕ title 随语言刷新
        // 无会话时重渲染空状态（标题/副标题/提示）；有会话时消息内容按持久化语言保留
        if (!this.manager.getActive()) {
            void this.renderMessages();
        }
    }

    private stopStreaming() {
        const conv = this.manager.getActive();
        if (!conv) return;
        // 只停止当前活动会话的流（按 sessionId 定向取消），其他会话的并发流不受影响
        this.stopRequests.add(conv.id);
        if (conv.sessionId) {
            // 记录取消落定屏障：drain 下一条前须等其彻底结束（同 session 复用防竞态）
            this.cancelBarriers.set(conv.id, this.plugin.cancelSession(conv.sessionId).catch(() => { /* ignore */ }));
        }
        // 尚无 sessionId（ensureSession 进行中）：只标记停止请求，
        // 由 processItem 流式循环首块的 stopRequests 检查生效；不可 cancelAll（会误伤其他会话并发流）
    }

    private async handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void this.sendMessage();
        }
    }

    /**
     * 发送：统一入队（回复流式期间也可继续输入），由队列泵 FIFO 串行发出。
     * 无活动会话时自动新建（方向 A：新建也受上限守卫，达上限时提示并中止，不自动裁剪旧会话）。
     */
    private async sendMessage(): Promise<void> {
        const text = this.inputEl.value.trim();
        if (!text) return;

        let conv = this.manager.getActive();
        if (!conv) {
            if (this.atConversationLimit()) return;
            conv = this.manager.createConversation();
            this.renderTabs();
        }

        // 入队并清空输入；记录入队时的笔记快照——排队期间切换笔记 / 焦点变化
        // 不影响本条消息实际携带的「当前文章」上下文
        this.sendQueue.enqueue(conv.id, text, this.currentFilePath);
        this.inputEl.value = '';
        this.adjustTextareaHeight();
        this.renderQueueBar();
        void this.pumpQueue();
    }

    /**
     * 队列泵：并发 drain 所有有排队项的会话（各会话独立 ACP session，互不阻塞——
     * 会话 A 流式期间，在会话 B 发送的问题立即并行回答）。
     */
    private async pumpQueue(): Promise<void> {
        for (const conv of this.manager.getAll()) {
            if (this.sendQueue.peekFor(conv.id)) {
                void this.drainConversation(conv.id);
            }
        }
    }

    /**
     * 单会话 drain：FIFO 串行处理该会话的排队项（先出队再处理，正在发送的不显示在队列条）。
     * draining 集合防重入（Deep/ACP 单进程多会话：同会话只允许一条 in-flight 流）；
     * 停止请求只影响当前条（processItem 内部检查并清除），队列保留继续。
     */
    private async drainConversation(convId: string): Promise<void> {
        if (this.draining.has(convId)) return;
        this.draining.add(convId);
        this.updateSendButton();
        try {
            while (true) {
                // 若上一项被停止/取消，先等取消彻底落定再发下一条：
                // 同 ACP session 复用，不等待会让下一条 prompt 撞上 in-flight 竞态（#high-race）
                const barrier = this.cancelBarriers.get(convId);
                if (barrier) {
                    this.cancelBarriers.delete(convId);
                    await barrier;
                }
                const item = this.sendQueue.peekFor(convId);
                if (!item) break;
                this.sendQueue.dequeue(convId);
                this.renderQueueBar();
                await this.processItem(item);
            }
        } finally {
            this.draining.delete(convId);
            this.cancelBarriers.delete(convId);
            this.updateSendButton();
            this.renderQueueBar();
        }
    }

    /**
     * 处理一条队列项：真正发送时写入历史并流式。
     * 会话已被删除 → 丢弃该项（不产生消息）。
     * 仅当该项属于当前活动会话时内联渲染流式；否则静默累积（切回该会话时可见完整回复）。
     */
    private async processItem(item: QueueItem): Promise<void> {
        const convId = item.convId;
        const conv = this.manager.getConversation(convId);
        if (!conv) return;

        // 确保 ACP 连接，并分配/校验 sessionId（断链自愈 2.1）：
        //  - 首次发送 → 新建 session
        //  - 连接代际变化（进程重启过）或进程已断开 → 旧 session 在新进程上已失效，强制换新
        //  - 其余多轮 → 复用 session 保持上下文连贯
        try {
            const epoch = this.plugin.adapter.getEpoch();
            const connected = this.plugin.adapter.isConnected();
            if (!conv.sessionId || this.sessionEpochs.get(convId) !== epoch || !connected) {
                const sessionId = await this.plugin.ensureSession(); // 断开时会在此触发自动重启
                this.manager.setSessionId(convId, sessionId);
                this.sessionEpochs.set(convId, this.plugin.adapter.getEpoch());
            }
        } catch (e) {
            const err = friendlyError(getErrorMessage(e));
            new Notice(t('chat.connFail', { err }));
            this.manager.addMessage(convId, 'assistant', t('chat.errorPrefix', { err }));
            return;
        }

        // 分支会话：首条发送时前置注入截至分叉点的对话转写（一次性，持久化在会话上，跨重载不丢）。
        // 读取即清除；连接失败路径不读不删，重试时仍能注入。
        const forkTranscript = conv.forkTranscript ?? null;
        if (forkTranscript !== null) {
            this.manager.setForkTranscript(convId, undefined);
        }

        // 真正发送时添加用户消息（进入历史 / 自动生成标题）
        this.manager.addMessage(convId, 'user', item.text);

        // 创建 AI 消息占位
        const aiMsg = this.manager.addMessage(convId, 'assistant', '');
        if (!aiMsg) return;

        this.streamingMsgIds.set(convId, aiMsg.id);

        // isActive 在渲染等待期间可能变化（用户切会话）——每次内联渲染前用最新值判断
        let isActive = this.manager.getActive()?.id === convId;
        let bubble: HTMLElement | null = null;

        let firstChunk = true;
        let thinkingContent = '';
        let textContent = '';
        let parts: MessagePart[] = [];
        let streamingError: string | null = null;
        try {
            // 仅当该项属于当前活动会话时内联渲染（气泡查找在 try 内：失败按错误消息处理，队列继续）
            if (isActive) {
                await this.renderMessages();
                // 渲染等待期间用户可能已切换会话：仅当仍为活动会话时才取气泡，
                // 否则回退为静默累积（切回该会话时可见完整回复），避免把流灌进别的会话的气泡
                if (this.manager.getActive()?.id !== convId) {
                    isActive = false;
                } else {
                    const streamingBubble = this.messageContainer.querySelector(
                        `.buddybridge-message-row[data-msg-id="${aiMsg.id}"] .buddybridge-bubble`
                    );
                    if (!(streamingBubble instanceof HTMLElement)) {
                        throw new Error('找不到 Assistant 消息气泡');
                    }
                    bubble = streamingBubble;
                }
            }

            const base = await this.buildContextText(convId, item.text, item.notePath);
            // 3.2：附加文件全文注入（用户显式固定，每条消息都带上）
            // 3.3 修复（M4）：与笔记全文注入同款上限，防超大附件每条消息重复撑爆上下文
            const attachList = this.attachedFiles.get(convId) ?? [];
            const attachText = attachList.length > 0
                ? '\n\n' + attachList.map(a => {
                    let content = a.content;
                    if (content.length > MAX_INJECTED_NOTE_CHARS) {
                        content = content.substring(0, MAX_INJECTED_NOTE_CHARS) + '\n…（内容过长已截断）';
                    }
                    return `[附加文件: ${a.path}]\n${content}`;
                }).join('\n\n')
                : '';
            // 注入文本不进对话历史，聊天仍显示原文；仅首条发送时注入（上面已读取并清除）
            const contextText = `${forkTranscript ? forkTranscript + '\n\n' : ''}${base}${attachText}`;
            const context: VaultContext = {
                currentNote: undefined,
                referencedNotes: [],
            };

            for await (const chunk of this.plugin.adapter.sendMessage(
                conv.sessionId,
                { content: contextText },
                context,
            )) {
                // 停止即时生效：点停止后不再渲染后续缓冲 chunk（仅当前会话，队列保留，下一条继续）
                if (this.stopRequests.has(convId)) break;

                if (firstChunk) {
                    firstChunk = false;
                    // 移除思考指示器（仅内联渲染时）
                    if (isActive && bubble) {
                        const thinking = bubble.querySelector('.buddybridge-thinking');
                        if (thinking instanceof HTMLElement) {
                            thinking.addClass('buddybridge-thinking-fadeout');
                            await new Promise(r => window.setTimeout(r, 200));
                            thinking.remove();
                        }
                    }
                }

                if (chunk.type === 'thinking') {
                    thinkingContent += chunk.content;
                    // 更新持久化 parts（思考合并为单个部分，内容流式追加）
                    const lastPart = parts[parts.length - 1];
                    if (lastPart && lastPart.kind === 'thinking') {
                        lastPart.content = thinkingContent;
                    } else {
                        parts.push({ kind: 'thinking', content: thinkingContent });
                    }
                    this.manager.updateMessageParts(convId, aiMsg.id, parts, true);
                    if (isActive && bubble) {
                        this.renderThinkingBlock(bubble, thinkingContent, t('chat.thinking'));
                    }
                } else if (chunk.type === 'tool') {
                    parts.push({ kind: 'tool', name: chunk.toolName, detail: chunk.toolDetail });
                    this.manager.updateMessageParts(convId, aiMsg.id, parts, true);
                    if (isActive && bubble) {
                        const toolsBlock = this.renderToolsBlock(bubble);
                        this.appendToolRow(toolsBlock, chunk.toolName, chunk.toolDetail);
                    }
                } else if (chunk.type === 'text') {
                    textContent += chunk.content;
                    this.manager.updateMessage(convId, aiMsg.id, textContent, true);
                    if (isActive && bubble) {
                        await this.renderMarkdownContent(bubble, textContent);
                    }
                } else if (chunk.type === 'error') {
                    streamingError = chunk.content;
                    const fErr = friendlyError(chunk.content);
                    this.manager.updateMessage(convId, aiMsg.id, t('chat.errorPrefix', { err: fErr }), true);
                    new Notice(t('chat.requestFail', { err: fErr }));
                } else if (chunk.type === 'done') {
                    // 3.1：记录本次回复用量（按会话）并刷新输入区环形指示
                    if (chunk.usage) {
                        this.usageByConv.set(convId, chunk.usage);
                        this.updateUsageMeter();
                    }
                    break;
                }
            }

            if (streamingError) {
                // P0.3/P0.5：错误卡直接写入内容，并清空可能残留的 parts
                this.manager.updateMessage(convId, aiMsg.id, t('chat.errorPrefix', { err: friendlyError(streamingError) }));
                this.manager.updateMessageParts(convId, aiMsg.id, undefined, true);
            } else {
                // 正文只存文本；思考/工具调用已通过 parts 持久化（流式结束后由 parts 重建可折叠块）
                this.manager.updateMessage(convId, aiMsg.id, textContent);
                const hasContent = Boolean(textContent || thinkingContent || parts.length > 0);
                const stopped = this.stopRequests.has(convId);
                if (!hasContent) {
                    this.manager.updateMessage(convId, aiMsg.id, stopped ? t('chat.stopped') : t('chat.noResponse'));
                } else if (stopped && textContent) {
                    this.manager.updateMessage(convId, aiMsg.id, textContent + '\n\n' + t('chat.stopped'));
                }
            }

            // 流式结束后从 parts 重建（思考块标签变「已思考」、工具卡保留可折叠）
            if (isActive) {
                await this.renderMessages();
            }
        } catch (error: unknown) {
            const message = friendlyError(getErrorMessage(error));
            this.manager.updateMessage(convId, aiMsg.id, t('chat.errorPrefix', { err: message }));
            // S3：catch 路径也清除残留的思考/工具 parts，避免错误卡下悬挂旧数据
            this.manager.updateMessageParts(convId, aiMsg.id, undefined, true);
            new Notice(t('chat.requestFail', { err: message }));
            if (isActive) {
                await this.renderMessages();
            }
        } finally {
            this.streamingMsgIds.delete(convId);
            this.stopRequests.delete(convId);
        }
        // S2：flush 移出流式 try——持久化失败不应把「已成功的回复」变成错误卡
        try {
            await this.manager.flush();
        } catch (e) {
            console.error('[BD] flush failed:', e);
        }
    }

    /** 渲染队列条：只显示「当前活跃会话」真正等待中的排队项（chip 可 ✕ 删除 / 点击内联编辑）。
     * 正在发送的项已先出队，不在此显示；其他会话的排队项也不在此展示（各会话队列独立）。 */
    private renderQueueBar(): void {
        if (!this.queueBar) return;
        const activeId = this.manager.getActive()?.id ?? null;
        const items = activeId ? this.sendQueue.listFor(activeId) : [];
        if (items.length === 0) {
            this.queueBar.empty();
            this.queueBar.addClass('buddybridge-hidden');
            return;
        }
        this.queueBar.empty();
        this.queueBar.removeClass('buddybridge-hidden');
        for (const item of items) {
            const chip = this.queueBar.createDiv({ cls: 'buddybridge-queue-chip' });
            const body = chip.createSpan({ cls: 'buddybridge-queue-chip-text', text: item.text });
            body.onclick = () => this.editQueueItem(item.id, chip, body);

            const del = chip.createSpan({
                cls: 'buddybridge-queue-chip-del',
                attr: { title: t('chat.queueDel'), 'aria-label': t('chat.queueDel'), role: 'button', tabindex: '0' }
            });
            setIcon(del, 'x');
            del.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                this.removeQueueItem(item.id);
            };
            del.onkeydown = (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.removeQueueItem(item.id);
                }
            };
        }
    }

    private removeQueueItem(id: string): void {
        this.sendQueue.remove(id);
        this.renderQueueBar();
    }

    /** 内联编辑：点击 chip 文本 → 变为输入框；Enter 保存 / Esc 取消 / 失焦保存。 */
    private editQueueItem(id: string, chip: HTMLElement, body: HTMLElement): void {
        let cancelled = false;
        const edit = document.createElement('input');
        edit.addClass('buddybridge-queue-chip-input');
        edit.type = 'text';
        edit.value = body.textContent ?? '';
        edit.addEventListener('keydown', (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                this.commitQueueEdit(id, edit.value);
            } else if (e.key === 'Escape') {
                cancelled = true;
                this.renderQueueBar();
            }
        });
        edit.addEventListener('blur', () => {
            if (!cancelled) this.commitQueueEdit(id, edit.value);
        });
        chip.replaceChild(edit, body);
        edit.focus();
        edit.select();
    }

    /** 提交队列项编辑：空内容视为删除该条。 */
    private commitQueueEdit(id: string, text: string): void {
        const trimmed = text.trim();
        if (!trimmed) {
            this.sendQueue.remove(id);
        } else {
            this.sendQueue.update(id, trimmed);
        }
        this.renderQueueBar();
    }

    private updateCurrentFileBar() {
        this.currentFileBar.setText(this.currentFilePath ? `📄 ${this.currentFilePath}` : '');
    }

    /** 刷新上下文用量指示（3.1）：按当前会话显示其用量（环形百分比 + 输入/输出/合计）；无则隐藏。 */
    private updateUsageMeter(): void {
        if (!this.usageMeter || !this.usageRing || !this.usageText) return;
        const conv = this.manager.getActive();
        const u = conv ? (this.usageByConv.get(conv.id) ?? null) : null;
        if (!u || u.totalTokens === undefined) {
            this.usageMeter.addClass('buddybridge-hidden');
            return;
        }
        this.usageMeter.removeClass('buddybridge-hidden');
        const pct = Math.min(100, (u.totalTokens / BuddyBridgeChatView.CONTEXT_WINDOW) * 100);
        this.usageRing.style.setProperty('--pct', pct.toFixed(1));
        const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        this.usageText.textContent =
            `↑${fmt(u.inputTokens ?? 0)} ↓${fmt(u.outputTokens ?? 0)} Σ${fmt(u.totalTokens)} / ${fmt(BuddyBridgeChatView.CONTEXT_WINDOW)}`;
    }

    // ==================== 附加文件（Phase 3.2） ====================

    /** 把笔记全文附加到当前会话上下文（3.2）。 */
    private async attachNoteToContext(file: TFile): Promise<void> {
        const conv = this.manager.getActive();
        if (!conv) return;
        const list = this.attachedFiles.get(conv.id) ?? [];
        if (list.some(a => a.path === file.path)) {
            new Notice(t('chat.attachAlready', { name: file.basename }));
            return;
        }
        let content: string;
        try {
            content = await this.app.vault.read(file);
        } catch (e) {
            new Notice(t('chat.attachReadFail', { err: getErrorMessage(e) }));
            return;
        }
        this.attachedFiles.set(conv.id, [...list, { path: file.path, content }]);
        this.renderAttachBar();
        new Notice(t('chat.attachOk', { name: file.basename }));
    }

    /** 移除当前会话的某个附加文件（3.2）。 */
    private removeAttachedFile(path: string): void {
        const conv = this.manager.getActive();
        if (!conv) return;
        const list = this.attachedFiles.get(conv.id) ?? [];
        this.attachedFiles.set(conv.id, list.filter(a => a.path !== path));
        this.renderAttachBar();
    }

    /** 渲染附加文件 chip 条（顶部，可 ✕ 移除；仅显示当前会话）。 */
    private renderAttachBar(): void {
        if (!this.attachBar) return;
        this.attachBar.empty();
        const conv = this.manager.getActive();
        const list = conv ? (this.attachedFiles.get(conv.id) ?? []) : [];
        if (list.length === 0) {
            this.attachBar.addClass('buddybridge-hidden');
            return;
        }
        this.attachBar.removeClass('buddybridge-hidden');
        for (const a of list) {
            const chip = this.attachBar.createDiv({ cls: 'buddybridge-attach-chip', attr: { title: a.path } });
            chip.createSpan({ text: `📎 ${a.path}`, cls: 'buddybridge-attach-chip-text' });
            const del = chip.createSpan({
                cls: 'buddybridge-attach-chip-del',
                attr: { title: t('chat.attachRemove'), role: 'button', tabindex: '0' }
            });
            setIcon(del, 'x');
            del.onclick = () => this.removeAttachedFile(a.path);
            del.onkeydown = (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.removeAttachedFile(a.path);
                }
            };
        }
    }

    private scrollToBottom() {
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }
}
