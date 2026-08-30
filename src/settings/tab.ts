import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type BuddyBridgePlugin from '../main';
import { DEFAULT_SETTINGS, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../types';
import { setLanguage, t } from '../i18n';
import { ConfirmModal } from './confirm';
import { BackendSetupModal } from './setup-modal';

export class BuddyBridgeSettingTab extends PluginSettingTab {
    plugin: BuddyBridgePlugin;

    constructor(app: App, plugin: BuddyBridgePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const plugin = this.plugin;

        // ==================== 连接配置 ====================
        new Setting(containerEl).setName(t('set.connHeading')).setHeading();

        // 一键配置后端（Phase 1.1，提到最前）：新电脑装好插件 → 点一次按钮 → 直接用
        new Setting(containerEl)
            .setName(t('set.setupName'))
            .setDesc(t('set.setupDesc'))
            .addButton(btn => btn
                .setButtonText(t('set.setupBtn'))
                .setCta()
                .onClick(() => {
                    new BackendSetupModal(this.app, plugin).open();
                }));

        new Setting(containerEl)
            .setName(t('set.cmdName'))
            .setDesc(t('set.cmdDesc'))
            .addText(text => text
                .setPlaceholder('dsh --profile acp')
                .setValue(plugin.settings.acpCommand)
                .onChange(async (value) => {
                    plugin.settings.acpCommand = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('set.timeoutName'))
            .setDesc(t('set.timeoutDesc'))
            .addText(text => text
                .setPlaceholder('300')
                .setValue(String(plugin.settings.timeoutSeconds))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        plugin.settings.timeoutSeconds = num;
                        await plugin.saveSettings();
                    }
                }));

        // DeepSeek API key：密码框，写入插件设置，启动 dsh 进程时注入环境变量（无需系统环境变量操作）
        new Setting(containerEl)
            .setName(t('set.apiKeyName'))
            .setDesc(t('set.apiKeyDesc'))
            .addText(text => {
                text.inputEl.type = 'password';
                text.inputEl.autocomplete = 'off';
                text.setPlaceholder('留空 = 自动读取 DSH Web 配置')
                    .setValue(plugin.settings.apiKey)
                    .onChange(async (value) => {
                        plugin.settings.apiKey = value.trim();
                        await plugin.saveSettings();
                    });
            });

        // DeepSeek Base URL：与 DSH Web 共用同一份地址（火山方舟等第三方端点），留空用官方默认
        new Setting(containerEl)
            .setName(t('set.baseUrlName'))
            .setDesc(t('set.baseUrlDesc'))
            .addText(text => text
                .setPlaceholder('https://api.deepseek.com')
                .setValue(plugin.settings.baseUrl)
                .onChange(async (value) => {
                    plugin.settings.baseUrl = value.trim();
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('set.diagName'))
            .setDesc(t('set.diagDesc'))
            .addButton(btn => btn
                .setButtonText(t('set.diagBtn'))
                .onClick(async () => {
                    await plugin.runDiagnose();
                }));

        // ==================== 上下文注入 ====================
        new Setting(containerEl).setName(t('set.ctxHeading')).setHeading();

        new Setting(containerEl)
            .setName(t('set.noteLinkName'))
            .setDesc(t('set.noteLinkDesc'))
            .addToggle(toggle => toggle
                .setValue(plugin.settings.noteLinkInjection)
                .onChange(async (value) => {
                    plugin.settings.noteLinkInjection = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('set.noteContentName'))
            .setDesc(t('set.noteContentDesc'))
            .addToggle(toggle => toggle
                .setValue(plugin.settings.injectNoteContent)
                .onChange(async (value) => {
                    plugin.settings.injectNoteContent = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('set.vaultCtxName'))
            .setDesc(t('set.vaultCtxDesc'))
            .addToggle(toggle => toggle
                .setValue(plugin.settings.vaultContextInjection)
                .onChange(async (value) => {
                    plugin.settings.vaultContextInjection = value;
                    await plugin.saveSettings();
                }));

        // ==================== 外观 ====================
        new Setting(containerEl).setName(t('set.appearanceHeading')).setHeading();

        new Setting(containerEl)
            .setName(t('set.colorName'))
            .setDesc(t('set.colorDesc'))
            .addText(text => {
                text.inputEl.type = 'color';
                text.setValue(plugin.settings.primaryColor || '#8b5cf6');
                text.onChange(async (value) => {
                    plugin.settings.primaryColor = value;
                    await plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName(t('set.fontName'))
            .setDesc(t('set.fontDesc'))
            .addSlider(slider => slider
                .setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, 1)
                .setValue(plugin.settings.fontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    plugin.settings.fontSize = value;
                    await plugin.saveSettings();
                }));

        // 界面语言（3.3 i18n）：切换后立即重渲染 + 全局语言生效
        new Setting(containerEl)
            .setName(t('set.langName'))
            .setDesc(t('set.langDesc'))
            .addDropdown(dropdown => dropdown
                .addOption('auto', t('set.langAuto'))
                .addOption('zh', t('set.langZh'))
                .addOption('en', t('set.langEn'))
                .setValue(plugin.settings.language)
                .onChange(async (value) => {
                    plugin.settings.language = value as 'zh' | 'en' | 'auto';
                    setLanguage(plugin.settings.language);
                    await plugin.saveSettings();
                    this.display();
                }));

        // ==================== 管理 ====================
        new Setting(containerEl).setName(t('set.mgmtHeading')).setHeading();

        new Setting(containerEl)
            .setName(t('set.maxConvName'))
            .setDesc(t('set.maxConvDesc'))
            .addText(text => text
                .setPlaceholder('20')
                .setValue(String(plugin.settings.maxConversations))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        plugin.settings.maxConversations = num;
                        await plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName(t('set.exportName'))
            .setDesc(t('set.exportDesc'))
            .addButton(btn => btn
                .setButtonText(t('set.exportBtn'))
                .onClick(async () => {
                    await plugin.exportData();
                }));

        new Setting(containerEl)
            .setName(t('set.importName'))
            .setDesc(t('set.importDesc'))
            .addButton(btn => {
                btn.setButtonText(t('set.importBtn'));
                btn.buttonEl.addEventListener('click', (evt: MouseEvent) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    void plugin.importDataFromFile();
                });
            });

        new Setting(containerEl)
            .setName(t('set.resetName'))
            .setDesc(t('set.resetDesc'))
            .addButton(btn => btn
                .setButtonText(t('set.resetBtn'))
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        t('set.resetConfirm'),
                        async () => {
                            plugin.settings = { ...DEFAULT_SETTINGS };
                            setLanguage(plugin.settings.language);
                            await plugin.saveSettings();
                            new Notice(t('set.resetNotice'));
                            this.display();
                        }
                    ).open();
                }));
    }
}
