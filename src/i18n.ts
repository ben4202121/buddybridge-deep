// ==================== 轻量 i18n（Phase 3.3） ====================
// 抽 key + 中英字典；t(key, vars) 按当前语言返回并插值 {var}。
// 语言来自插件 settings.language（'auto' = 跟随 Obsidian locale，moment.locale() 前缀 zh → 中文）。
// 边界：本模块只负责「用户可见 UI」字符串；adapter/内部日志/注入提示词保持中文不动。

export type Lang = 'zh' | 'en' | 'auto';

export type DictEntry = { zh: string; en: string };

const DICT: Record<string, DictEntry> = {
    // ==================== 权限弹窗（permission.ts） ====================
    'perm.title': { zh: 'DSH 请求权限', en: 'DSH Permission Request' },
    'perm.tool': { zh: '工具: {name}', en: 'Tool: {name}' },
    'perm.cancel': { zh: '取消', en: 'Cancel' },
    'perm.allowAlwaysHint': {
        zh: '如需「始终允许」该工具，请在 DSH 侧配置 policy（ACP profile 的权限策略）。',
        en: 'To always allow this tool, configure a policy on the DSH side (ACP profile permission policy).',
    },

    // ==================== 确认弹窗（confirm.ts） ====================
    'confirm.ok': { zh: '确认', en: 'Confirm' },

    // ==================== 设置页（tab.ts） ====================
    'set.connHeading': { zh: '连接配置', en: 'Connection' },
    'set.setupName': { zh: '一键配置后端', en: 'One-click Backend Setup' },
    'set.setupDesc': {
        zh: '自动探测 dsh、装配 dsh-acp-demo、编译 koffi 并生成配置文件，完成后自动填入 ACP 命令。写入 ~/.dsh 或全局安装 pnpm/dsh 前均会先征求确认。',
        en: 'Detects dsh, assembles dsh-acp-demo, compiles koffi and generates config files, then auto-fills the ACP command. Asks for confirmation before writing ~/.dsh or installing pnpm/dsh globally.',
    },
    'set.setupBtn': { zh: '开始配置', en: 'Start Setup' },
    'set.cmdName': { zh: 'DSH ACP 命令', en: 'DSH ACP Command' },
    'set.cmdDesc': {
        zh: '启动 ACP stdio 服务器的命令。默认 `dsh --profile acp`。也可填 `dsh-acp-demo -c <路径>` 或自定义命令。',
        en: 'Command to start the ACP stdio server. Default `dsh --profile acp`. Can also be `dsh-acp-demo -c <path>` or a custom command.',
    },
    'set.timeoutName': { zh: '请求超时时长（秒）', en: 'Request Timeout (seconds)' },
    'set.timeoutDesc': {
        zh: '单次请求超过该时长未收到完整回复时自动终止并提示（默认 300 秒）',
        en: 'Auto-cancel and notify when a request exceeds this duration without a complete reply (default 300s)',
    },
    'set.apiKeyName': { zh: 'DeepSeek API Key', en: 'DeepSeek API Key' },
    'set.apiKeyDesc': {
        zh: '留空时自动从 DSH Web 的凭据配置（~/.dsh/.credentials.yaml）读取同一份密钥，无需手动填写；仅覆盖时才在此填写（保存后写入 DSH 全局 ~/.dsh/.env）。',
        en: 'When empty, the key is auto-read from DSH Web\'s credentials config (~/.dsh/.credentials.yaml) — no manual entry needed; fill only to override (saved to ~/.dsh/.env).',
    },
    'diag.apiKeyName': { zh: 'DeepSeek API Key', en: 'DeepSeek API Key' },
    'diag.apiKeyOk': { zh: '已配置（插件设置 / ~/.dsh/.env / DSH Web 凭据配置）', en: 'Configured (plugin / ~/.dsh/.env / DSH Web credentials)' },
    'diag.apiKeyMissing': { zh: '未配置', en: 'Not configured' },
    'diag.apiKeyFix': {
        zh: '在 DSH Web 的模型设置中配置密钥后，本插件会自动读取；也可在 设置 → 连接配置 →「DeepSeek API Key」手动粘贴。',
        en: 'Configure the key in DSH Web models settings and the plugin reads it automatically; or paste it in Settings → Connection → "DeepSeek API Key".',
    },
    'set.baseUrlName': { zh: 'DeepSeek Base URL', en: 'DeepSeek Base URL' },
    'set.baseUrlDesc': {
        zh: '留空时自动从 DSH Web 的全局配置（~/.dsh/settings.yaml）读取同一份地址（如火山方舟），与 DSH Web 一致；仅覆盖时才在此填写。',
        en: 'When empty, auto-read from DSH Web\'s global config (~/.dsh/settings.yaml, e.g. Volcano Ark) — same as DSH Web; fill only to override.',
    },
    'diag.baseUrlName': { zh: 'DeepSeek Base URL', en: 'DeepSeek Base URL' },
    'diag.baseUrlOk': { zh: '已配置（插件设置 / ~/.dsh/.env / DSH Web 全局配置）', en: 'Configured (plugin / ~/.dsh/.env / DSH Web global config)' },
    'diag.baseUrlDefault': { zh: '未配置，将使用官方默认 https://api.deepseek.com', en: 'Not configured — will use https://api.deepseek.com' },
    'diag.baseUrlFix': {
        zh: 'DSH Web 全局配置（~/.dsh/settings.yaml）里有地址时会自动读取；如火山方舟端点未生效，请在 设置 → 连接配置 →「DeepSeek Base URL」手动填写。',
        en: 'Auto-read from DSH Web global config (~/.dsh/settings.yaml) when present; fill Settings → Connection → "DeepSeek Base URL" manually if the endpoint is not picked up.',
    },
    'set.diagName': { zh: '诊断连接', en: 'Diagnose Connection' },
    'set.diagDesc': {
        zh: '检查 DSH ACP 命令、可执行文件与进程状态',
        en: 'Check the DSH ACP command, executable and process state',
    },
    'set.diagBtn': { zh: '诊断', en: 'Diagnose' },
    'set.ctxHeading': { zh: '上下文注入', en: 'Context Injection' },
    'set.noteLinkName': { zh: '注入当前笔记路径', en: 'Inject Current Note Path' },
    'set.noteLinkDesc': {
        zh: '发送消息时自动在消息前附加 [当前笔记: 路径]，让 AI 知道你在看哪个笔记（默认开启）',
        en: 'Prepend [Current Note: path] to messages so the AI knows which note you are viewing (default on)',
    },
    'set.noteContentName': { zh: '注入当前笔记全文', en: 'Inject Current Note Content' },
    'set.noteContentDesc': {
        zh: '额外把当前笔记全文附在消息前（默认关闭；Harness 有文件工具，可自行读取）',
        en: 'Prepend the full current note content (default off; Harness has file tools to read it itself)',
    },
    'set.vaultCtxName': { zh: '注入 Vault 上下文', en: 'Inject Vault Context' },
    'set.vaultCtxDesc': {
        zh: '额外附加 [Vault: 仓库根路径]，帮助 AI 理解笔记所在的仓库（默认关闭）',
        en: 'Prepend [Vault: root path] to help the AI understand the vault (default off)',
    },
    'set.appearanceHeading': { zh: '外观', en: 'Appearance' },
    'set.colorName': { zh: '主色调', en: 'Primary Color' },
    'set.colorDesc': {
        zh: '聊天面板的主题色。留空使用 Obsidian 默认强调色。',
        en: 'Chat panel accent color. Leave empty to use Obsidian\'s default.',
    },
    'set.fontName': { zh: '字体大小', en: 'Font Size' },
    'set.fontDesc': {
        zh: '聊天面板（消息气泡、Markdown 内容、输入框与排队项）的文字大小',
        en: 'Text size in the chat panel (bubbles, Markdown, input, queue items)',
    },
    'set.langName': { zh: '界面语言', en: 'Language' },
    'set.langDesc': {
        zh: '界面显示语言；「跟随 Obsidian」按 Obsidian 语言自动选择（中/英）',
        en: 'UI language; "Follow Obsidian" picks Chinese/English from Obsidian\'s locale',
    },
    'set.langAuto': { zh: '跟随 Obsidian', en: 'Follow Obsidian' },
    'set.langZh': { zh: '简体中文', en: 'Simplified Chinese' },
    'set.langEn': { zh: 'English', en: 'English' },
    'set.mgmtHeading': { zh: '管理', en: 'Manage' },
    'set.maxConvName': { zh: '最大对话数', en: 'Max Conversations' },
    'set.maxConvDesc': {
        zh: '同时最多存在多少个对话；达到上限后禁止新建（提示「对话已满」），需先删除旧对话（方向 A，不再自动裁剪）',
        en: 'Maximum concurrent conversations; creating is blocked at the limit — delete old ones first (no auto-trimming)',
    },
    'set.exportName': { zh: '导出设置（含聊天记录）', en: 'Export Settings (with Chat History)' },
    'set.exportDesc': {
        zh: '将全部设置与聊天记录导出为带版本号的 JSON 文件，用于备份或迁移',
        en: 'Export all settings and chat history to a versioned JSON file for backup or migration',
    },
    'set.exportBtn': { zh: '导出', en: 'Export' },
    'set.importName': { zh: '导入设置（含聊天记录）', en: 'Import Settings (with Chat History)' },
    'set.importDesc': {
        zh: '从 JSON 文件恢复设置与聊天记录（会覆盖当前数据，需二次确认）',
        en: 'Restore settings and chat history from a JSON file (overwrites current data, requires confirmation)',
    },
    'set.importBtn': { zh: '导入', en: 'Import' },
    'set.resetName': { zh: '重置为默认', en: 'Reset to Default' },
    'set.resetDesc': {
        zh: '将所有设置恢复为默认值（不会删除聊天记录，需二次确认）',
        en: 'Restore all settings to defaults (chat history is kept, requires confirmation)',
    },
    'set.resetBtn': { zh: '重置', en: 'Reset' },
    'set.resetConfirm': { zh: '确认将所有设置恢复为默认值？聊天记录将保留。', en: 'Reset all settings to defaults? Chat history will be kept.' },
    'set.resetNotice': { zh: '设置已重置为默认', en: 'Settings reset to defaults' },

    // ==================== 主插件（main.ts） ====================
    'cmd.openChat': { zh: '打开聊天面板', en: 'Open Chat Panel' },
    'cmd.diagnose': { zh: '诊断 DSH 连接', en: 'Diagnose DSH Connection' },
    'cmd.clearConv': { zh: '清空当前对话', en: 'Clear Current Conversation' },
    'ribbon.chat': { zh: 'BuddyBridge Deep 聊天', en: 'BuddyBridge Deep Chat' },
    'main.loadFail': { zh: 'BuddyBridge Deep 加载失败，请查看 Console', en: 'BuddyBridge Deep failed to load, check the Console' },
    'main.openFail': { zh: 'BuddyBridge Deep：打开面板失败，请查看 Console', en: 'BuddyBridge Deep: failed to open panel, check the Console' },
    'main.createFail': { zh: 'BuddyBridge Deep：无法创建聊天面板', en: 'BuddyBridge Deep: cannot create chat panel' },
    'main.exportOk': { zh: '已导出设置与聊天记录', en: 'Exported settings and chat history' },
    'main.importOk': { zh: '导入成功', en: 'Import successful' },
    'main.exportFail': { zh: '导出失败: {err}', en: 'Export failed: {err}' },
    'main.importFail': { zh: '导入失败: {err}', en: 'Import failed: {err}' },
    'main.importFailFormat': {
        zh: '导入失败：文件格式不正确，或导出版本与本插件不兼容',
        en: 'Import failed: invalid file format or incompatible export version',
    },
    'main.importConfirm': {
        zh: '导入将覆盖当前设置与 {count} 条聊天记录，是否继续？',
        en: 'Import will overwrite current settings and {count} chat records. Continue?',
    },
    'diag.title': { zh: 'DSH ACP 诊断', en: 'DSH ACP Diagnostics' },
    'diag.close': { zh: '关闭', en: 'Close' },

    // ==================== 聊天视图顶层 UI（chat.ts） ====================
    'chat.placeholder': { zh: '输入消息... (Shift+Enter 换行，Enter 发送)', en: 'Type a message... (Shift+Enter newline, Enter send)' },
    'chat.send': { zh: '发送', en: 'Send' },
    'chat.newChat': { zh: '新建对话', en: 'New Chat' },
    'chat.closeConv': { zh: '关闭对话', en: 'Close Conversation' },
    'chat.emptyTitle': { zh: '开始新对话', en: 'Start a New Chat' },
    'chat.emptySubtitle': { zh: '输入消息开始聊天，或点击 + 新建对话', en: 'Type a message to chat, or click + for a new conversation' },
    'chat.tipTitle': { zh: '💡 提示', en: '💡 Tips' },
    'chat.tipEnter': { zh: 'Shift+Enter 换行，Enter 发送', en: 'Shift+Enter for a newline, Enter to send' },
    'chat.tipMultiTurn': {
        zh: '同一对话内多轮保持上下文（重启后为新会话）',
        en: 'Multi-turn context is kept within a conversation (a new session starts after restart)',
    },
    'chat.convFull': {
        zh: '对话已满（最多 {max} 个），请先删除旧对话再新建',
        en: 'Too many conversations (max {max}). Delete one to create a new one.',
    },
    'chat.stopped': { zh: '（已停止）', en: '(stopped)' },
    'chat.noResponse': { zh: '（无响应，请重试）', en: '(no response, please retry)' },
    'chat.thinking': { zh: '思考中...', en: 'Thinking...' },
    'chat.requestFail': { zh: '请求失败: {err}', en: 'Request failed: {err}' },
    'chat.connFail': { zh: '连接 DSH 失败: {err}', en: 'Failed to connect to DSH: {err}' },
    'chat.errorPrefix': { zh: '错误: {err}', en: 'Error: {err}' },
    'chat.stop': { zh: '停止', en: 'Stop' },
    'chat.forkFrom': { zh: '从这里继续新对话', en: 'Continue here in a new conversation' },
    'chat.thought': { zh: '已思考', en: 'Thought' },
    'chat.toolCalls': { zh: '工具调用', en: 'Tool Calls' },
    'chat.requestFailTitle': { zh: '请求失败', en: 'Request Failed' },
    'chat.retry': { zh: '重试', en: 'Retry' },
    'chat.retryAria': { zh: '重试上次发送', en: 'Retry last send' },
    'chat.errHintConfig': {
        zh: '请在设置中确认 DSH ACP 命令正确，并点击「诊断连接」检查。',
        en: 'Confirm the DSH ACP command in Settings and click "Diagnose Connection".',
    },
    'chat.noApiKeyHint': {
        zh: '未配置 DeepSeek API Key：请在 设置 → 连接配置 →「DeepSeek API Key」粘贴你的密钥（platform.deepseek.com 创建，sk- 开头）后再试。',
        en: 'No DeepSeek API Key configured: paste your key in Settings → Connection → "DeepSeek API Key" (create at platform.deepseek.com, starts with sk-) and retry.',
    },
    'chat.errHintTimeout': { zh: '请求超时，请重试。', en: 'Request timed out, please retry.' },
    'chat.queueDel': { zh: '删除该条', en: 'Remove this item' },
    'chat.attachToConv': { zh: '附加到当前会话上下文', en: 'Attach to Current Conversation' },
    'chat.tipSetup': {
        zh: '需先配置 DSH ACP（设置页可诊断连接）',
        en: 'Set up DSH ACP first (Settings → Diagnose Connection)',
    },
    'chat.attachAlready': { zh: '「{name}」已附加', en: '"{name}" is already attached' },
    'chat.attachReadFail': { zh: '读取笔记失败: {err}', en: 'Failed to read note: {err}' },
    'chat.attachOk': { zh: '已附加「{name}」到当前会话', en: 'Attached "{name}" to the current conversation' },
    'chat.attachRemove': { zh: '移除', en: 'Remove' },
    'chat.usageTitle': { zh: '上下文占用', en: 'Context usage' },
};

/** 当前生效语言（zh/en 二态；auto 在 setLanguage 时已解析）。 */
let currentLang: 'zh' | 'en' = 'zh';

export function setLanguage(lang: Lang): void {
    currentLang = lang === 'auto' ? detectObsidianLocale() : lang;
}

export function getLang(): 'zh' | 'en' {
    return currentLang;
}

/** 从 Obsidian locale 探测语言（moment.locale() 前缀 zh → 中文；无信号回落中文；测试可注入 window.moment）。 */
export function detectObsidianLocale(): 'zh' | 'en' {
    try {
        const locale = (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.() ?? '';
        if (!locale) return 'zh';
        return /^zh/i.test(locale) ? 'zh' : 'en';
    } catch {
        return 'zh';
    }
}

/** 取翻译；未知 key 回退 key 本身（便于发现漏配）。支持 {var} 插值。 */
export function t(key: string, vars?: Record<string, string | number>): string {
    const entry = DICT[key];
    let text = entry ? entry[currentLang] : key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.split(`{${k}}`).join(String(v));
        }
    }
    return text;
}

/**
 * 把对最终用户不可操作的底层错误转成可操作的双语引导文案。
 * 命中已知场景（如未配置 API key）返回友好提示；未命中原样返回，不吞错误。
 */
export function friendlyError(err: string): string {
    if (/no api key/i.test(err)) {
        return t('chat.noApiKeyHint');
    }
    return err;
}
