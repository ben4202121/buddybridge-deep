// ==================== DSH 全局共享配置读取单测（4.3 自动复制 DSH Web 配置） ====================
// 用临时目录 + DSH_HOME 环境变量隔离，绝不触碰真实 ~/.dsh。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readDshCredentialsKey, readDshSettingsBaseUrl } from '../src/core/dsh-shared';

let tmp: string;
let realDshHome: string | undefined;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-shared-test-'));
    realDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
});

afterEach(() => {
    if (realDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realDshHome;
    rmSync(tmp, { recursive: true, force: true });
});

function write(fileName: string, content: string): void {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, fileName), content, 'utf8');
}

describe('readDshCredentialsKey (DSH Web 凭据 ~/.dsh/.credentials.yaml)', () => {
    it('文件缺失返回 undefined', async () => {
        await expect(readDshCredentialsKey()).resolves.toBeUndefined();
    });

    it('读取 refs 下的明文 key（火山方舟形态），忽略其他键', async () => {
        write('.credentials.yaml', 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "abc-def-ghi-12345"\n  OTHER: keep-me\n');
        await expect(readDshCredentialsKey()).resolves.toBe('abc-def-ghi-12345');
    });

    it('顶层明文 key 同样可读（兼容其他格式）；空值返回 undefined', async () => {
        write('.credentials.yaml', 'version: 1\nDEEPSEEK_API_KEY: sk-top-level-99\n');
        await expect(readDshCredentialsKey()).resolves.toBe('sk-top-level-99');
        write('.credentials.yaml', 'version: 1\nDEEPSEEK_API_KEY: ""\n');
        await expect(readDshCredentialsKey()).resolves.toBeUndefined();
    });

    it('env: 引用：进程环境有该变量则取其值，否则 undefined', async () => {
        const old = process.env.BB_TEST_KEY;
        try {
            process.env.BB_TEST_KEY = 'from-env-42';
            write('.credentials.yaml', 'refs:\n  DEEPSEEK_API_KEY: env:BB_TEST_KEY\n');
            await expect(readDshCredentialsKey()).resolves.toBe('from-env-42');
            delete process.env.BB_TEST_KEY;
            await expect(readDshCredentialsKey()).resolves.toBeUndefined();
        } finally {
            if (old === undefined) delete process.env.BB_TEST_KEY;
            else process.env.BB_TEST_KEY = old;
        }
    });

    it('未找到 DEEPSEEK_API_KEY 键返回 undefined', async () => {
        write('.credentials.yaml', 'version: 1\nrefs:\n  OTHER_API_KEY: x\n');
        await expect(readDshCredentialsKey()).resolves.toBeUndefined();
    });
});

describe('readDshSettingsBaseUrl (DSH Web 全局地址 ~/.dsh/settings.yaml)', () => {
    it('文件缺失返回 undefined', async () => {
        await expect(readDshSettingsBaseUrl()).resolves.toBeUndefined();
    });

    it('读取 llm-deepseek 节下的 baseURL（含引号去除），忽略其他节', async () => {
        write('settings.yaml', [
            'ui-onboarding:',
            '  welcomeNoticeVersion: 2026-08-13.1',
            'llm-deepseek:',
            '  baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3"',
        ].join('\n'));
        await expect(readDshSettingsBaseUrl()).resolves.toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
    });

    it('其他节下的 baseURL 不会被误读', async () => {
        write('settings.yaml', 'some-other:\n  baseURL: https://wrong.example.com\n');
        await expect(readDshSettingsBaseUrl()).resolves.toBeUndefined();
    });

    it('未配置 llm-deepseek 返回 undefined', async () => {
        write('settings.yaml', 'ui-onboarding:\n  welcomeNoticeVersion: x\n');
        await expect(readDshSettingsBaseUrl()).resolves.toBeUndefined();
    });
});
