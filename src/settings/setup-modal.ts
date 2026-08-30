// ==================== 一键配置后端：进度 Modal（Phase 1.1） ====================
// 引导式流程：确认 → 逐步执行（runBackendSetup）→ 失败可授权全局装 pnpm/dsh 重试
// → 成功自动回填 acpCommand 并 saveSettings → 可选冒烟检验。

import { App, Modal, Notice } from 'obsidian';
import type BuddyBridgePlugin from '../main';
import { createHostSetupContext } from '../backend/host-context';
import { runBackendSetup, type SetupOptions, type SetupResult, type SetupStepStatus } from '../backend/setup';
import { runAcpSmoke } from '../backend/smoke';

export class BackendSetupModal extends Modal {
    private plugin: BuddyBridgePlugin;
    private stepsEl: HTMLElement | null = null;
    private actionsEl: HTMLElement | null = null;
    private allowInstallDsh = false;
    private allowInstallPnpm = false;
    private stepRows = new Map<string, { icon: HTMLElement; detail: HTMLElement }>();

    constructor(app: App, plugin: BuddyBridgePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen(): void {
        this.renderConfirm();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    // ==================== 渲染 ====================

    private renderConfirm(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '一键配置 DSH ACP 后端' });
        contentEl.createEl('p', {
            text: '插件将自动完成以下操作：',
            cls: 'buddybridge-setup-desc',
        });
        const ul = contentEl.createEl('ul', { cls: 'buddybridge-setup-list' });
        const items = [
            '探测 dsh，并自动确定配套的 dsh-acp-demo 版本',
            '写入 ~/.dsh/profiles/acp/（package.json / pnpm-workspace.yaml / cordis.yml）',
            '在 profile 目录运行 pnpm install 编译 koffi 原生库',
            '自动把启动命令填入「DSH ACP 命令」并保存',
        ];
        for (const it of items) ul.createEl('li', { text: it });
        contentEl.createEl('p', {
            text: '若本机未安装 pnpm 或 dsh，会在对应步骤经你确认后全局安装（npm install -g）。',
            cls: 'buddybridge-setup-warn',
        });

        this.actionsEl = contentEl.createDiv({ cls: 'buddybridge-confirm-actions' });
        const cancel = this.actionsEl.createEl('button', { text: '取消' });
        cancel.onclick = () => this.close();
        const start = this.actionsEl.createEl('button', { text: '开始配置', cls: 'mod-cta' });
        start.onclick = () => void this.run();
    }

    private renderSteps(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '正在配置后端…' });
        this.stepsEl = contentEl.createDiv({ cls: 'buddybridge-setup-steps' });
        this.actionsEl = contentEl.createDiv({ cls: 'buddybridge-confirm-actions' });
    }

    /** 同名步骤复用同一行（running → ok/fail 只更新图标与详情，不新增重复行）。 */
    private addStep(name: string, status: SetupStepStatus, detail?: string): void {
        if (!this.stepsEl) return;
        let entry = this.stepRows.get(name);
        if (!entry) {
            const row = this.stepsEl.createDiv({ cls: 'buddybridge-setup-step' });
            const icon = row.createSpan({ cls: 'buddybridge-setup-step-icon' });
            const body = row.createDiv({ cls: 'buddybridge-setup-step-body' });
            body.createDiv({ cls: 'buddybridge-setup-step-name', text: name });
            const detailEl = body.createDiv({ cls: 'buddybridge-setup-step-detail' });
            entry = { icon, detail: detailEl };
            this.stepRows.set(name, entry);
        }
        entry.icon.setText(status === 'running' ? '…' : status === 'ok' ? '✓' : '✗');
        if (detail !== undefined) entry.detail.setText(detail);
    }

    private clearActions(): void {
        if (this.actionsEl) this.actionsEl.empty();
    }

    // ==================== 流程 ====================

    private runOptions(): SetupOptions {
        return {
            onStep: (name, status, detail) => this.addStep(name, status, detail),
            allowInstallDsh: this.allowInstallDsh,
            allowInstallPnpm: this.allowInstallPnpm,
        };
    }

    private async run(): Promise<void> {
        this.renderSteps();
        const result = await runBackendSetup(createHostSetupContext(), this.runOptions());
        if (result.ok && result.acpCommand) {
            this.onSuccess(result);
        } else {
            this.onFailure(result);
        }
    }

    /** 成功：自动回填 acpCommand 并保存。 */
    private async onSuccess(result: SetupResult): Promise<void> {
        const { acpCommand } = result;
        this.plugin.settings.acpCommand = acpCommand || '';
        await this.plugin.saveSettings();
        new Notice('后端配置完成，ACP 命令已自动填入');

        this.addStep('完成', 'ok', `已保存 ACP 命令：${acpCommand}`);
        this.clearActions();
        if (!this.actionsEl) return;
        const smoke = this.actionsEl.createEl('button', { text: '运行冒烟测试', cls: 'mod-cta' });
        smoke.onclick = () => void this.runSmoke();
        const close = this.actionsEl.createEl('button', { text: '关闭' });
        close.onclick = () => this.close();
    }

    private async onFailure(result: SetupResult): Promise<void> {
        // 缺 pnpm / dsh 且未授权时，询问是否自动安装后重试（按稳定错误码分支，不匹配文案）
        const needDsh = result.errorCode === 'NO_DSH';
        const needPnpm = result.errorCode === 'NO_PNPM';
        if ((needDsh && !this.allowInstallDsh) || (needPnpm && !this.allowInstallPnpm)) {
            // 失败原因已由 onStep 渲染为步骤行，这里只补充询问
            this.clearActions();
            if (!this.actionsEl) return;
            const msg = this.actionsEl.createDiv({ cls: 'buddybridge-setup-warn' });
            msg.setText(needDsh
                ? '未找到 dsh（DeepSeek Harness）。是否用 npm 全局安装？'
                : '未找到 pnpm。是否用 npm 全局安装？');
            const install = this.actionsEl.createEl('button', { text: '自动安装', cls: 'mod-cta' });
            install.onclick = () => {
                if (needDsh) this.allowInstallDsh = true;
                if (needPnpm) this.allowInstallPnpm = true;
                void this.run();
            };
            const cancel = this.actionsEl.createEl('button', { text: '取消' });
            cancel.onclick = () => this.close();
            return;
        }

        this.addStep('失败', 'fail', result.error ?? '未知错误');
        this.clearActions();
        if (!this.actionsEl) return;
        const retry = this.actionsEl.createEl('button', { text: '重试', cls: 'mod-cta' });
        retry.onclick = () => void this.run();
        const close = this.actionsEl.createEl('button', { text: '关闭' });
        close.onclick = () => this.close();
    }

    /** 冒烟：start → initialize → newSession → prompt(探测)。非致命。 */
    private async runSmoke(): Promise<void> {
        this.addStep('冒烟测试', 'running');
        const result = await runAcpSmoke({
            command: this.plugin.settings.acpCommand,
            cwd: this.plugin.getVaultPath(),
            timeoutMs: 15000,
            // 与正式链路一致的注入：插件内配置的 key/地址 → 环境变量
            env: (this.plugin.settings.apiKey || this.plugin.settings.baseUrl)
                ? {
                    ...(this.plugin.settings.apiKey ? { DEEPSEEK_API_KEY: this.plugin.settings.apiKey } : {}),
                    ...(this.plugin.settings.baseUrl ? { DEEPSEEK_BASE_URL: this.plugin.settings.baseUrl } : {}),
                }
                : undefined,
            onLog: (m) => console.log('[BD] smoke:', m),
        });
        // 同名行复用：running → ok/fail 原位更新
        if (result.ok || result.warning) {
            this.addStep('冒烟测试', 'ok', result.detail || result.warning);
        } else {
            this.addStep('冒烟测试', 'fail', result.detail);
        }
    }
}
