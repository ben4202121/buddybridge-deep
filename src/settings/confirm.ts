import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * 通用二次确认弹窗：用于「重置为默认」「导入覆盖」等破坏性操作。
 */
export class ConfirmModal extends Modal {
    private message: string;
    private onConfirm: () => void | Promise<void>;

    constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: this.message, cls: 'buddybridge-confirm-message' });
        const actions = contentEl.createDiv({ cls: 'buddybridge-confirm-actions' });
        const cancelBtn = actions.createEl('button', { text: t('perm.cancel'), cls: 'mod-cta' });
        cancelBtn.onclick = () => this.close();
        const okBtn = actions.createEl('button', { text: t('confirm.ok'), cls: 'mod-warning' });
        okBtn.onclick = async () => {
            try {
                await this.onConfirm();
            } catch (e) {
                console.error('[BD] 确认操作失败:', e);
            } finally {
                this.close();
            }
        };
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
