// ==================== 真实执行上下文（Node fs/child_process/os） ====================
// 供设置页「一键配置后端」在 Obsidian/Electron 内执行。setup.ts 保持纯逻辑可单测，
// 本文件是它的生产环境实现：spawn 非 shell（沿用 resolveShimTarget 直启规避 cmd/GBK/空格）。

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { resolveExecutable, resolveShimTarget } from '../bridges/deep/cli';
import { resolveExecTarget, type SetupContext, type SpawnResult } from './setup';

/** 执行命令并等待结束（非 shell；.cmd/.bat 若无法转 JS 入口则退化 shell:true）。 */
async function runProcess(program: string, args: string[], cwd?: string): Promise<SpawnResult> {
    const ext = path.extname(program).toLowerCase();
    const needShell = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
    return new Promise<SpawnResult>((resolve) => {
        let proc: ChildProcess;
        try {
            proc = spawn(program, args, {
                cwd,
                shell: needShell,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e) {
            resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
            return;
        }
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        proc.on('error', (e: Error) => {
            resolve({ code: null, stdout, stderr: stderr || e.message });
        });
        proc.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

/** 构建生产用 SetupContext。npm 走 resolveExecTarget 直启（绕开 .cmd/GBK/空格）。 */
export function createHostSetupContext(): SetupContext {
    const base = {
        homeDir: () => os.homedir(),
        env: (name: string) => process.env[name],
        exists: (p: string) => pathExists(p),
        readFile: (p: string) => {
            try {
                return fs.readFileSync(p, 'utf8');
            } catch {
                return null;
            }
        },
        writeFile: (p: string, content: string) => {
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                // UTF-8 无 BOM（BOM 会让 dsh 的 JSON.parse 崩）
                fs.writeFileSync(p, content, { encoding: 'utf8' });
                return true;
            } catch {
                return false;
            }
        },
        mkdir: (p: string) => {
            try {
                fs.mkdirSync(p, { recursive: true });
                return true;
            } catch {
                return false;
            }
        },
        exec: (program: string, args: string[], opts?: { cwd?: string }) =>
            runProcess(program, args, opts?.cwd),
        resolveExecutable,
        resolveShimTarget,
    };
    const ctx: SetupContext = {
        ...base,
        npmVersions: async (pkg: string): Promise<string[] | null> => {
            try {
                const npmPath = base.resolveExecutable('npm');
                if (!npmPath) return null;
                // npm 是 .cmd shim：经 resolveExecTarget 转 node <npm-cli.js> 直启
                const target = resolveExecTarget(ctx, npmPath);
                const res = await runProcess(target.program, [...target.args, 'view', pkg, 'versions', '--json']);
                if (res.code !== 0) return null;
                const trimmed = res.stdout.trim();
                if (!trimmed) return null;
                const parsed: unknown = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.filter((v): v is string => typeof v === 'string');
                }
                return null;
            } catch {
                return null;
            }
        },
    };
    return ctx;
}

/** 路径是否存在（文件或目录均可）。 */
function pathExists(p: string): boolean {
    try {
        const st = fs.statSync(p);
        return st.isFile() || st.isDirectory();
    } catch {
        return false;
    }
}
