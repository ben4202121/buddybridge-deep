// ==================== DSH 全局环境配置（4.0 全局 API Key） ====================
// DSH 官方 launch-environment 的 user-env 层 = `$DSH_HOME/.env`：
// 该文件中的键值会在每次启动 DSH 进程时被物化进进程环境（官方机制，见
// dsh-launch-environment README 的层级表）。因此把 DeepSeek API key 写入此处，
// DSH Web 与本插件的 Harness 进程**共用同一份配置**——一次配置、全局生效。
// 本模块只操作 .env 文件本身，绝不打印任何键的值。

import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';

/** DSH 用户主目录（默认 ~/.dsh，可被环境变量 DSH_HOME 覆盖）。 */
export function dshHomePath(): string {
    return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

/** DSH 全局 .env 文件路径。 */
export function dshEnvPath(): string {
    return join(dshHomePath(), '.env');
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 读取 DSH 全局 .env 中某键的值（Windows 大小写不敏感，与 launch-environment 一致）；缺失返回 undefined。 */
export async function readDshEnvValue(key: string): Promise<string | undefined> {
    let text: string;
    try {
        text = await readFile(dshEnvPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'im');
    const line = text.split(/\r?\n/).find((l) => re.test(l));
    if (line === undefined) return undefined;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

/**
 * 更新 DSH 全局 .env 中某键的值，保留其余行/注释/格式（immutable：返回新内容）。
 * value 为 undefined 时删除该键。
 */
export async function upsertDshEnvValue(key: string, value: string | undefined): Promise<void> {
    const file = dshEnvPath();
    let text = '';
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'im');
    let next: string;
    if (value === undefined) {
        // 删除该键所在行（连同整行内容与注释）
        next = text.split(/\r?\n/).filter((l) => !re.test(l)).join('\n').replace(/\n{2,}/g, '\n').trim() + '\n';
    } else if (re.test(text)) {
        next = text.replace(re, `${key}=${value}`);
    } else if (text.trim().length === 0) {
        next = `${key}=${value}\n`;
    } else {
        next = text.replace(/\s*$/, '\n') + `${key}=${value}\n`;
    }

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next, 'utf8');
}
