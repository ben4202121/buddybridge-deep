import { App, Modal } from 'obsidian';
import type { PermissionRequest, PermissionResponse } from '../core/bridge-adapter';
import { t } from '../i18n';

/**
 * DSH ACP 权限请求弹窗：展示服务器提供的权限选项（allow_once / reject_once / allow_always ...）。
 * 用户在弹窗中选择 → resolve；关闭弹窗（Esc / 关闭按钮）→ cancelled。
 * 官方 @deepseek-ai/dsh-acp 只提供 allow_once / reject_once；当服务器未提供 allow_always 时，
 * 提示"始终允许"需由 DSH 侧 policy 配置（2.2）。
 */
export class PermissionModal extends Modal {
    private request: PermissionRequest;
    private resolve: (response: PermissionResponse) => void;
    private settled = false;

    constructor(app: App, request: PermissionRequest, resolve: (r: PermissionResponse) => void) {
        super(app);
        this.request = request;
        this.resolve = resolve;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('perm.title'), cls: 'buddybridge-permission-title' });
        contentEl.createEl('p', {
            text: t('perm.tool', {
                name: this.request.toolCall.title || this.request.toolCall.name || this.request.toolCall.toolCallId || '?',
            }),
            cls: 'buddybridge-permission-tool',
        });
        const actions = contentEl.createDiv({ cls: 'buddybridge-confirm-actions buddybridge-permission-actions' });
        for (const opt of this.request.options) {
            const btn = actions.createEl('button', {
                text: opt.name,
                cls: opt.kind.includes('allow') ? 'mod-cta' : 'mod-warning',
            });
            btn.onclick = () => this.settle({ outcome: 'selected', optionId: opt.optionId });
        }
        const cancelBtn = actions.createEl('button', { text: t('perm.cancel') });
        cancelBtn.onclick = () => this.settle({ outcome: 'cancelled' });
        // 官方 dsh-acp 不提供 allow_always → 提示始终允许由 DSH 侧 policy 配置（2.2）
        if (!this.request.options.some(o => o.kind === 'allow_always')) {
            contentEl.createEl('p', {
                text: t('perm.allowAlwaysHint'),
                cls: 'buddybridge-permission-hint',
            });
        }
    }

    private settle(response: PermissionResponse): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(response);
        this.close();
    }

    onClose(): void {
        this.settle({ outcome: 'cancelled' });
        this.contentEl.empty();
    }
}
