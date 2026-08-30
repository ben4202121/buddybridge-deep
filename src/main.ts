import { Notice, Plugin, Modal } from 'obsidian';
import { DeepSeekBridgeAdapter, createVaultToolContext } from './bridges/deep/cli';
import type { BridgeConfig, DiagnosticResult, PermissionRequest, PermissionResponse } from './core/bridge-adapter';
import { BuddyBridgeChatView, VIEW_TYPE_CHAT } from './views/chat';
import { migrateSettings, normalizePersistedData, getErrorMessage, type BuddyBridgeSettings, type PersistedData } from './types';
import { readDshEnvValue, upsertDshEnvValue } from './core/dsh-env';
import { readDshCredentialsKey, readDshSettingsBaseUrl } from './core/dsh-shared';
import { BuddyBridgeSettingTab } from './settings/tab';
import { PermissionModal } from './settings/permission';
import { buildExportPayload, serializeExport, parseExport, downloadJSONFile, pickAndReadJSONFile, type BuddyBridgeExport } from './io';
import { ConfirmModal } from './settings/confirm';
import { getLang, setLanguage, t } from './i18n';

export default class BuddyBridgePlugin extends Plugin {
    settings: BuddyBridgeSettings;
    adapter: DeepSeekBridgeAdapter;
    chatView: BuddyBridgeChatView | null = null;
    private connected = false;
    /** 上次实际生效的界面语言（getLang 结果）；语言变化时重注册命令/刷新 ribbon 与聊天面板（3.3 修复）。 */
    private lastLang: 'zh' | 'en' | null = null;
    private ribbonIcon: HTMLElement | null = null;

    private get vaultPath(): string | undefined {
        try {
            const adapter = this.app.vault.adapter as { basePath?: string };
            return adapter.basePath;
        } catch {
            return undefined;
        }
    }

    /** 供 VaultTool 上下文绑定使用（buildVaultToolContext）。 */
    getVaultPath(): string | undefined {
        return this.vaultPath;
    }

    async onload() {
        try {
            await this.loadSettings();
            setLanguage(this.settings.language); // 3.3 i18n：启动即按设置确定界面语言
            this.lastLang = getLang();

            this.adapter = new DeepSeekBridgeAdapter();
            // 权限请求 → Obsidian 弹窗
            this.adapter.setPermissionHandler((request: PermissionRequest) => {
                return new Promise<PermissionResponse>((resolve) => {
                    if (this.chatView && this.chatView.getManager().getActive()) {
                        new PermissionModal(this.app, request, resolve).open();
                    } else {
                        resolve({ outcome: 'cancelled' });
                    }
                });
            });

            // 注册聊天视图
            this.registerView(
                VIEW_TYPE_CHAT,
                (leaf) => {
                    const view = new BuddyBridgeChatView(leaf, this, async () => {
                        const data = normalizePersistedData(await this.loadData());
                        return data.conversations || [];
                    });
                    this.chatView = view;

                    view.getManager().setPersistCallback(async (conversations) => {
                        const data = normalizePersistedData(await this.loadData());
                        data.conversations = conversations;
                        await this.saveData(data);
                    });

                    return view;
                }
            );

            // Ribbon 按钮（保存元素句柄：语言切换时更新提示文案）
            this.ribbonIcon = this.addRibbonIcon('bot', t('ribbon.chat'), async () => {
                await this.activateView();
            });

            // 命令面板（语言切换时重注册，见 registerCommands）
            this.registerCommands();

            this.addSettingTab(new BuddyBridgeSettingTab(this.app, this));
            this.applyPrimaryColor();
            this.applyFontSize();
        } catch (e) {
            console.error('[BD] 插件加载失败:', e);
            new Notice(t('main.loadFail'));
        }
    }

    onunload() {
        if (this.adapter) {
            this.adapter.dispose().catch(() => { /* ignore */ });
        }
    }

    async activateView() {
        try {
            const { workspace } = this.app;
            let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

            if (!leaf) {
                leaf = workspace.getRightLeaf(true);
                if (!leaf) {
                    leaf = workspace.getLeaf(true);
                }
                if (leaf) {
                    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
                }
            }

            if (leaf) {
                await workspace.revealLeaf(leaf);
                workspace.setActiveLeaf(leaf, { focus: true });
            } else {
                new Notice(t('main.createFail'));
            }
        } catch (e) {
            console.error('[BD] 打开聊天面板失败:', e);
            new Notice(t('main.openFail'));
        }
    }

    async loadSettings() {
        const data = normalizePersistedData(await this.loadData());
        this.settings = migrateSettings(data.settings);
    }

    async saveSettings() {
        const existingData = normalizePersistedData(await this.loadData());
        const merged: PersistedData = { ...existingData, settings: this.settings };
        await this.saveData(merged);
        // 4.0 全局密钥 / 4.2 全局地址：配置了 apiKey / baseUrl 时同步写入 DSH 全局配置
        //（~/.dsh/.env，官方 user-env 层），DSH Web 与本插件共用同一份；写失败只提示，不阻断设置保存。
        if (this.settings.apiKey || this.settings.baseUrl) {
            try {
                if (this.settings.apiKey) await upsertDshEnvValue('DEEPSEEK_API_KEY', this.settings.apiKey);
                if (this.settings.baseUrl) await upsertDshEnvValue('DEEPSEEK_BASE_URL', this.settings.baseUrl);
            } catch (error) {
                new Notice(`[BD] 写入 DSH 全局配置失败: ${getErrorMessage(error)}`);
            }
        }
        // 连接配置变化后重置连接状态
        this.connected = false;
        if (this.chatView) {
            this.chatView.getManager().setMaxConversations(this.settings.maxConversations);
        }
        this.applyPrimaryColor();
        this.applyFontSize();
        this.applyLanguageUi(); // 3.3 i18n：语言变化时立即全局生效（命令/ribbon/打开的面板）
    }

    // ==================== i18n UI 刷新（3.3 修复） ====================

    /** 注册命令面板命令（t() 名称）；语言切换时重注册以更新名称。 */
    private registerCommands(): void {
        const scoped = (id: string) => `${this.manifest.id}:${id}`;
        for (const id of ['open-chat', 'diagnose', 'clear-conversation']) {
            this.removeCommand(scoped(id));
        }
        this.addCommand({
            id: 'open-chat',
            name: t('cmd.openChat'),
            callback: async () => {
                await this.activateView();
            }
        });
        this.addCommand({
            id: 'diagnose',
            name: t('cmd.diagnose'),
            callback: async () => {
                await this.runDiagnose();
            }
        });
        this.addCommand({
            id: 'clear-conversation',
            name: t('cmd.clearConv'),
            callback: async () => {
                if (this.chatView) {
                    await this.chatView.clearConversation();
                }
            }
        });
    }

    /** 更新 ribbon 按钮提示文案（Obsidian 在注册时快照 title/aria-label）。 */
    private updateRibbonTitle(): void {
        if (!this.ribbonIcon) return;
        this.ribbonIcon.setAttribute('aria-label', t('ribbon.chat'));
        this.ribbonIcon.setAttribute('title', t('ribbon.chat'));
    }

    /**
     * 应用当前语言设置；仅当实际语言发生变化时才重注册命令、刷新 ribbon 与
     * 打开的聊天面板（避免每次保存设置都重建命令面板）。启动时 lastLang 已在
     * onload 对齐，此处只处理运行期切换。
     */
    private applyLanguageUi(): void {
        setLanguage(this.settings.language);
        const lang = getLang();
        if (lang === this.lastLang) return;
        this.lastLang = lang;
        this.registerCommands();
        this.updateRibbonTitle();
        this.chatView?.refreshUi();
    }

    // ==================== 连接管理 ====================

    /** 确保 ACP 已连接（惰性初始化，避免阻塞插件加载）。 */
    async ensureConnected(): Promise<void> {
        if (this.connected) return;
        // 4.3 自动复制 DSH Web 配置：插件未显式填写时，自动从 DSH 全局配置读取
        //（key → ~/.dsh/.credentials.yaml，地址 → ~/.dsh/settings.yaml），与 DSH Web 完全一致。
        // 手动填写优先，作为可选覆盖。
        const autoKey = this.settings.apiKey ? undefined : await readDshCredentialsKey();
        const autoBaseUrl = this.settings.baseUrl ? undefined : await readDshSettingsBaseUrl();
        const config: BridgeConfig = {
            command: this.settings.acpCommand,
            vaultPath: this.vaultPath,
            timeoutMs: this.settings.timeoutSeconds * 1000,
            apiKey: this.settings.apiKey || autoKey,
            baseUrl: this.settings.baseUrl || autoBaseUrl,
        };
        await this.adapter.initialize(config);
        this.connected = true;
    }

    /** 确保连接并为新会话创建 ACP session。 */
    async ensureSession(): Promise<string> {
        await this.ensureConnected();
        return this.adapter.createSession();
    }

    /** 取消指定会话的流式请求；resolve 表示取消已落定（队列泵据此决定何时复用该 session）。 */
    cancelSession(sessionId: string): Promise<void> {
        return this.adapter.cancel(sessionId);
    }

    cancelAllSessions(): Promise<void> {
        return this.adapter.cancel();
    }

    // ==================== 诊断 ====================

    async runDiagnose(): Promise<void> {
        try {
            await this.ensureConnected();
        } catch (e) {
            // 连接失败也要展示诊断（此时 adapter 已记录错误信息）
            console.warn('[BD] 诊断: 初始化失败', getErrorMessage(e));
        }
        const result = await this.adapter.diagnose();
        // 4.0/4.2/4.3：追加「API Key / Base URL」状态检查项（不显示密钥内容，地址只显已/未配置）
        // 有效值来源：插件手动设置 → ~/.dsh/.env → DSH Web 全局配置（credentials.yaml / settings.yaml）
        const [envKey, envBaseUrl, credKey, settingsBaseUrl] = await Promise.all([
            readDshEnvValue('DEEPSEEK_API_KEY'),
            readDshEnvValue('DEEPSEEK_BASE_URL'),
            readDshCredentialsKey(),
            readDshSettingsBaseUrl(),
        ]);
        const hasKey = Boolean(this.settings.apiKey || envKey || credKey);
        const hasBaseUrl = Boolean(this.settings.baseUrl || envBaseUrl || settingsBaseUrl);
        const checks = [...result.checks,
            {
                name: t('diag.apiKeyName'),
                passed: hasKey,
                message: hasKey ? t('diag.apiKeyOk') : t('diag.apiKeyMissing'),
                fix: hasKey ? undefined : t('diag.apiKeyFix'),
            },
            {
                name: t('diag.baseUrlName'),
                passed: true,
                message: hasBaseUrl ? t('diag.baseUrlOk') : t('diag.baseUrlDefault'),
                fix: hasBaseUrl ? undefined : t('diag.baseUrlFix'),
            },
        ];
        this.showDiagnostic({ ...result, checks });
    }

    private showDiagnostic(result: DiagnosticResult): void {
        const modal = new Modal(this.app);
        modal.contentEl.empty();
        modal.titleEl.setText(t('diag.title'));
        const list = modal.contentEl.createDiv({ cls: 'buddybridge-diagnostic-list' });
        for (const check of result.checks) {
            const row = list.createDiv({ cls: 'buddybridge-diagnostic-row' });
            row.createSpan({
                cls: `buddybridge-diagnostic-status ${check.passed ? 'is-ok' : 'is-fail'}`,
                text: check.passed ? '✓' : '✗',
            });
            const body = row.createDiv({ cls: 'buddybridge-diagnostic-body' });
            body.createDiv({ cls: 'buddybridge-diagnostic-name', text: check.name });
            if (check.message) {
                body.createDiv({ cls: 'buddybridge-diagnostic-message', text: check.message });
            }
            if (check.fix) {
                body.createDiv({ cls: 'buddybridge-diagnostic-fix', text: `💡 ${check.fix}` });
            }
        }
        const actions = modal.contentEl.createDiv({ cls: 'buddybridge-confirm-actions' });
        const closeBtn = actions.createEl('button', { text: t('diag.close'), cls: 'mod-cta' });
        closeBtn.onclick = () => modal.close();
        modal.open();
    }

    // ==================== 导出 / 导入 ====================

    async exportData(): Promise<void> {
        try {
            const data = normalizePersistedData(await this.loadData());
            const payload = buildExportPayload(data.settings ?? {}, data.conversations ?? []);
            const json = serializeExport(payload);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            downloadJSONFile(`buddybridge-deep-backup-${stamp}.json`, json);
            new Notice(t('main.exportOk'));
        } catch (e) {
            console.error('[BD] 导出失败:', e);
            new Notice(t('main.exportFail', { err: getErrorMessage(e) }));
        }
    }

    async importDataFromFile(): Promise<void> {
        try {
            const json = await pickAndReadJSONFile();
            if (!json) return;
            const payload = parseExport(json);
            if (!payload) {
                new Notice(t('main.importFailFormat'));
                return;
            }
            new ConfirmModal(
                this.app,
                t('main.importConfirm', { count: payload.conversations.length }),
                async () => {
                    await this.importData(payload);
                    new Notice(t('main.importOk'));
                }
            ).open();
        } catch (e) {
            console.error('[BD] 导入失败:', e);
            new Notice(t('main.importFail', { err: getErrorMessage(e) }));
        }
    }

    async importData(payload: BuddyBridgeExport): Promise<void> {
        const data = normalizePersistedData(await this.loadData());
        data.settings = payload.settings;
        data.conversations = payload.conversations;
        await this.saveData(data);

        this.settings = migrateSettings(payload.settings);
        this.connected = false;
        this.applyPrimaryColor();
        this.applyFontSize();
        this.applyLanguageUi(); // 3.3：导入后语言立即全局生效

        if (this.chatView) {
            await this.chatView.loadConversations(payload.conversations);
        }
    }

    applyPrimaryColor() {
        try {
            const value = this.settings.primaryColor || 'var(--interactive-accent)';
            const containers = document.querySelectorAll('.buddybridge-chat-container');
            containers.forEach((container) => {
                if (container instanceof HTMLElement) {
                    container.setCssProps({ '--buddybridge-primary': value });
                }
            });
        } catch (e) {
            console.error('[BD] 应用主色调失败:', e);
        }
    }

    /** 应用聊天区字体大小（气泡 + Markdown 内容 + 输入框 + 排队项，经 --buddybridge-font-size 变量）。 */
    applyFontSize() {
        try {
            const value = `${this.settings.fontSize}px`;
            const containers = document.querySelectorAll('.buddybridge-chat-container');
            containers.forEach((container) => {
                if (container instanceof HTMLElement) {
                    container.setCssProps({ '--buddybridge-font-size': value });
                }
            });
        } catch (e) {
            console.error('[BD] 应用字体大小失败:', e);
        }
    }
}

// 供 VaultTool 上下文使用的绑定（Vault API 注入）
export function buildVaultToolContext(plugin: BuddyBridgePlugin) {
    const vault = plugin.app.vault;
    return createVaultToolContext({
        read: (p) => vault.adapter.read(p),
        modify: (p, content) => vault.adapter.write(p, content),
        create: (p, content) => vault.adapter.write(p, content),
        exists: (p) => vault.adapter.exists(p),
        getFiles: () => plugin.app.vault.getFiles().map(f => ({
            path: f.path,
            basename: f.basename,
            extension: f.extension,
        })),
        adapter: { basePath: plugin.getVaultPath() },
    });
}
