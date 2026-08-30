// ==================== DSH 全局共享配置读取（4.3 自动复制 DSH Web 配置） ====================
// DSH Web 的地址与 key 分别以明文存于两个官方配置文件：
//   - key     → `$DSH_HOME/.credentials.yaml`（dsh-credentials-local 服务管理）
//   - baseURL → `$DSH_HOME/settings.yaml`（`llm-deepseek.baseURL`）
// 插件在用户未手动配置时自动读取这两份文件并注入 Harness 进程，与 DSH Web 完全一致，
// 实现「一次都不用手动粘贴」。本模块只解析配置，绝不打印任何键的值。

import { join } from 'path';
import { readFile } from 'fs/promises';
import { dshHomePath } from './dsh-env';

/**
 * 扁平 YAML 子集查询：逐行解析 `key: value`（支持 2 空格缩进表达顶层节）。
 * top 为 null 时在任意层级搜索 key（凭据文件）；否则只在指定顶层节内搜索（settings.yaml）。
 * 返回去引号的值；未命中返回 undefined。
 */
function findYamlValue(text: string, top: string | null, key: string): string | undefined {
    let inTop = top === null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        const indent = line.length - line.trimStart().length;
        if (indent === 0) {
            const m = line.match(/^([A-Za-z0-9_.\/-]+)\s*:\s*(.*)$/);
            if (!m) continue;
            // 顶层键值对（凭据文件常见：`KEY: value`）直接尝试命中目标键；
            // 顶层节（无值）才切换 inTop 分区。
            if (m[2].trim() !== '') {
                if (m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
                continue;
            }
            inTop = top === null || m[1] === top;
            continue;
        }
        if (!inTop) continue;
        const m = line.match(/^\s*([A-Za-z0-9_.\/-]+)\s*:\s*(.*)$/);
        if (m && m[1] === key) {
            return m[2].trim().replace(/^["']|["']$/g, '');
        }
    }
    return undefined;
}

async function readDshFile(fileName: string): Promise<string | undefined> {
    try {
        return await readFile(join(dshHomePath(), fileName), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/**
 * 读取 DSH Web 的 DeepSeek API key（~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY）。
 * 支持官方 refs 语义：值为 `env:VAR` 引用时取进程环境变量（拿不到返回 undefined）。
 */
export async function readDshCredentialsKey(): Promise<string | undefined> {
    const text = await readDshFile('.credentials.yaml');
    if (text === undefined) return undefined;
    const value = findYamlValue(text, null, 'DEEPSEEK_API_KEY');
    if (value === undefined || value === '') return undefined;
    const ref = value.match(/^env:([A-Za-z0-9_]+)$/i);
    if (ref) {
        const envVal = process.env[ref[1]];
        return envVal && envVal.length > 0 ? envVal : undefined;
    }
    return value;
}

/** 读取 DSH Web 的 API 地址（~/.dsh/settings.yaml 的 llm-deepseek.baseURL）；未配置返回 undefined。 */
export async function readDshSettingsBaseUrl(): Promise<string | undefined> {
    const text = await readDshFile('settings.yaml');
    if (text === undefined) return undefined;
    const value = findYamlValue(text, 'llm-deepseek', 'baseURL');
    return value && value !== '' ? value : undefined;
}
