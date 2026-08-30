// ==================== 设置导入/导出 ====================

import {
    isObject,
    getNumber,
    migrateSettings,
    normalizeConversation,
    DATA_VERSION,
    type Conversation,
    type BuddyBridgeSettings,
} from './types';

/** 导出文件格式标识（防止误导入其他插件的 JSON） */
export const EXPORT_FORMAT = 'buddybridge-deep-export';
/** 导出文件自身格式版本号（未来迁移时递增；不兼容版本拒绝导入） */
export const EXPORT_VERSION = 1;

export interface BuddyBridgeExport {
    format: string;
    exportVersion: number;
    /** 数据 blob 格式版本（与 loadData 的 dataVersion 对应） */
    dataVersion: number;
    exportedAt: number;
    settings: BuddyBridgeSettings;
    conversations: Conversation[];
}

export function buildExportPayload(
    settings: Partial<BuddyBridgeSettings>,
    conversations: Conversation[],
): BuddyBridgeExport {
    return {
        format: EXPORT_FORMAT,
        exportVersion: EXPORT_VERSION,
        dataVersion: DATA_VERSION,
        exportedAt: Date.now(),
        settings: migrateSettings(settings),
        conversations: (conversations || [])
            .map(c => normalizeConversation(c))
            .filter((c): c is Conversation => c !== null),
    };
}

export function serializeExport(payload: BuddyBridgeExport): string {
    return JSON.stringify(payload, null, 2);
}

/**
 * 校验并规范化导入对象。
 * - 格式标识不符 → 拒绝
 * - exportVersion 不兼容（> 当前版本）→ 拒绝
 * - settings 与 conversations 均做归一化
 */
export function validateExport(raw: unknown): BuddyBridgeExport | null {
    if (!isObject(raw)) return null;
    if (raw.format !== EXPORT_FORMAT) return null;
    if (getNumber(raw, 'exportVersion') !== EXPORT_VERSION) return null;
    const dataVersion = getNumber(raw, 'dataVersion');
    if (typeof dataVersion !== 'number' || dataVersion < 1) return null;

    const settings = isObject(raw.settings) ? migrateSettings(raw.settings) : migrateSettings(null);
    const rawConvs = raw.conversations;
    const conversations: Conversation[] = Array.isArray(rawConvs)
        ? rawConvs
            .map(c => normalizeConversation(c))
            .filter((c): c is Conversation => c !== null)
        : [];

    return {
        format: EXPORT_FORMAT,
        exportVersion: EXPORT_VERSION,
        dataVersion,
        exportedAt: getNumber(raw, 'exportedAt') ?? Date.now(),
        settings,
        conversations,
    };
}

/** 解析 JSON 字符串为导出对象；非法 JSON 或结构不合法返回 null。 */
export function parseExport(json: string): BuddyBridgeExport | null {
    try {
        return validateExport(JSON.parse(json));
    } catch {
        return null;
    }
}

// ==================== 桌面端文件交互（Obsidian/Electron）====================
// 以下函数依赖浏览器 DOM / Electron，仅在桌面端调用；node 单测无法覆盖，故整体标记 istanbul ignore。

/* istanbul ignore next */
export function downloadJSONFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.classList.add('buddybridge-helper-hidden');
    document.body.appendChild(a);
    a.click();
    if (a.parentElement) a.remove();
    URL.revokeObjectURL(url);
}

/* istanbul ignore next */
function pickJSONViaElectron(): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const w = window as unknown as { require?: (m: string) => any };
            if (typeof w.require !== 'function') {
                resolve(null);
                return;
            }
            const electron = w.require('electron');
            const remote = electron?.remote;
            const dialog = remote?.dialog ?? electron?.dialog;
            if (!dialog) {
                resolve(null);
                return;
            }
            const win = remote?.getCurrentWindow ? remote.getCurrentWindow() : null;
            const opts = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
            const p = win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
            if (!p || typeof p.then !== 'function') {
                resolve(null);
                return;
            }
            p.then(async (result: unknown) => {
                const r = result as { filePaths?: unknown } | null;
                const filePath = Array.isArray(r?.filePaths) && r.filePaths.length > 0 ? r.filePaths[0] : '';
                if (!filePath) {
                    resolve(''); // 用户取消
                    return;
                }
                try {
                    const fs = w.require('fs');
                    const content = await fs.promises.readFile(filePath as string, 'utf-8');
                    resolve(String(content));
                } catch {
                    resolve(null);
                }
            }).catch(() => resolve(null));
        } catch {
            resolve(null);
        }
    });
}

/* istanbul ignore next */
function pickJSONViaDomInput(): Promise<string> {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.classList.add('buddybridge-helper-hidden');
        document.body.appendChild(input);

        let safetyTimer = 0;
        const cleanup = () => {
            if (safetyTimer) window.clearTimeout(safetyTimer);
            if (input.parentElement) input.remove();
        };
        const finish = (value: string) => { cleanup(); resolve(value); };
        const fail = (err: Error) => { cleanup(); reject(err); };

        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) {
                finish('');
                return;
            }
            const reader = new FileReader();
            reader.onload = () => finish(String(reader.result ?? ''));
            reader.onerror = () => fail(new Error('读取文件失败'));
            reader.readAsText(file);
        };
        (input as HTMLInputElement & { oncancel?: () => void }).oncancel = () => finish('');

        safetyTimer = window.setTimeout(() => finish(''), 60000);

        input.click();
    });
}

/* istanbul ignore next */
export async function pickAndReadJSONFile(): Promise<string> {
    const viaElectron = await pickJSONViaElectron();
    if (viaElectron !== null) return viaElectron;
    return pickJSONViaDomInput();
}
