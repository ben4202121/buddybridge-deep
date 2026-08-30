// ==================== DSH 全局环境配置单测（4.0 全局 API Key） ====================
// 用临时目录 + DSH_HOME 环境变量隔离，绝不触碰真实 ~/.dsh。

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dshHomePath, dshEnvPath, readDshEnvValue, upsertDshEnvValue } from '../src/core/dsh-env';

let tmp: string;
let realDshHome: string | undefined;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-env-test-'));
    realDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
});

afterEach(() => {
    if (realDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realDshHome;
    rmSync(tmp, { recursive: true, force: true });
});

describe('dsh-env (4.0 全局 API Key)', () => {
    it('dshHomePath 默认 ~/.dsh，DSH_HOME 覆盖', () => {
        expect(dshEnvPath()).toBe(join(tmp, '.env'));
        expect(dshHomePath()).toBe(tmp);
    });

    it('readDshEnvValue：文件缺失返回 undefined', async () => {
        await expect(readDshEnvValue('DEEPSEEK_API_KEY')).resolves.toBeUndefined();
    });

    it('readDshEnvValue：取到值并去引号；Windows 大小写不敏感', async () => {
        writeFileSync(join(tmp, '.env'), 'DEEPSEEK_API_KEY="sk-abc123"\nOTHER=keep\n', 'utf8');
        await expect(readDshEnvValue('DEEPSEEK_API_KEY')).resolves.toBe('sk-abc123');
        await expect(readDshEnvValue('deepseek_api_key')).resolves.toBe('sk-abc123');
        await expect(readDshEnvValue('MISSING')).resolves.toBeUndefined();
    });

    it('upsertDshEnvValue：新增键，保留其他行', async () => {
        writeFileSync(join(tmp, '.env'), '# my env\nBASE_URL=https://x\n', 'utf8');
        await upsertDshEnvValue('DEEPSEEK_API_KEY', 'sk-new-1');
        const text = readFileSync(join(tmp, '.env'), 'utf8');
        expect(text).toContain('# my env');
        expect(text).toContain('BASE_URL=https://x');
        expect(text).toContain('DEEPSEEK_API_KEY=sk-new-1');
    });

    it('upsertDshEnvValue：更新已有键，不产生重复行', async () => {
        writeFileSync(join(tmp, '.env'), 'DEEPSEEK_API_KEY=old\nOTHER=1\n', 'utf8');
        await upsertDshEnvValue('DEEPSEEK_API_KEY', 'sk-new-2');
        const text = readFileSync(join(tmp, '.env'), 'utf8');
        expect(text).toContain('DEEPSEEK_API_KEY=sk-new-2');
        expect(text).not.toContain('DEEPSEEK_API_KEY=old');
        expect(text.match(/DEEPSEEK_API_KEY/g)).toHaveLength(1);
        expect(text).toContain('OTHER=1');
    });

    it('upsertDshEnvValue：value undefined 删除该键，保留其余', async () => {
        writeFileSync(join(tmp, '.env'), 'DEEPSEEK_API_KEY=old\nOTHER=1\n', 'utf8');
        await upsertDshEnvValue('DEEPSEEK_API_KEY', undefined);
        const text = readFileSync(join(tmp, '.env'), 'utf8');
        expect(text).not.toContain('DEEPSEEK_API_KEY');
        expect(text).toContain('OTHER=1');
    });

    it('upsertDshEnvValue：文件不存在时自动创建目录与文件', async () => {
        const deep = join(tmp, 'a', 'b');
        process.env.DSH_HOME = deep;
        await upsertDshEnvValue('DEEPSEEK_API_KEY', 'sk-x');
        expect(existsSync(join(deep, '.env'))).toBe(true);
        await expect(readDshEnvValue('DEEPSEEK_API_KEY')).resolves.toBe('sk-x');
    });
});
