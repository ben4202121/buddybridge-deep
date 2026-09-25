import * as path from 'path';
import { splitCommand } from '../src/bridges/deep/cli';
import {
    parseDshVersion,
    defaultDemoVersionFor,
    pickDemoVersion,
    buildPnpmWorkspaceYaml,
    mergePnpmWorkspaceYaml,
    normalizeProfilePackageJson,
    buildCordisYml,
    computeProfilePaths,
    resolveExecTarget,
    runBackendSetup,
    computeAcpCommand,
    KNOWN_DEMO_VERSIONS,
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    DEMO_NPM_PACKAGE,
} from '../src/backend/setup';
import type { SetupContext, SetupOptions, SetupResult, SpawnResult } from '../src/backend/setup';

// ==================== 内存 Mock 上下文 ====================

interface MockState {
    files: Map<string, string>;
    dshPath: string | null;
    pnpmPath: string | null;
    envDshHome?: string;
    publishedVersions: string[] | null;
    dshVersionOutput: string;
    pluginAddExit: number;
    pnpmInstallExit: number;
    pnpmInstallStderr: string;
    execCalls: Array<{ program: string; args: string[]; cwd?: string }>;
    stepLog: Array<{ name: string; status: string; detail?: string }>;
    /** 命中这些规范化路径的 writeFile 将返回 false（模拟权限/锁失败）。 */
    failWritePaths?: string[];
}

function norm(p: string): string {
    return path.normalize(p).toLowerCase();
}

// 模拟真实 Windows npm shim：.cmd → node <npm-cli.js> 直启
const NPM_CMD = 'C:/fake/npm/npm.cmd';
const NPM_CLI_ENTRY = 'C:/fake/npm/node_modules/npm/bin/npm-cli.js';

function createMockContext(init: Partial<MockState> = {}): { ctx: SetupContext; state: MockState } {
    const state: MockState = {
        files: new Map(),
        dshPath: 'C:/fake/npm/dsh.cmd',
        pnpmPath: 'C:/fake/npm/pnpm.cmd',
        envDshHome: undefined,
        publishedVersions: ['0.1.1-rc.2', '0.1.1-rc.1', '0.1.0-rc.8', '0.1.0-rc.7'],
        dshVersionOutput: 'dsh 0.1.1-rc.2\n',
        pluginAddExit: 0,
        pnpmInstallExit: 0,
        pnpmInstallStderr: '',
        execCalls: [],
        stepLog: [],
        ...init,
    };
    const home = 'C:/Users/fake';
    const paths = computeProfilePaths(home, state.envDshHome);

    // 预置：dsh plugin add 之后的 profile package.json（含 demo 依赖）
    state.files.set(
        norm(paths.packageJsonPath),
        JSON.stringify({ dependencies: { [`${DEMO_NPM_PACKAGE}`]: '0.1.1-rc.2' } }, null, 2),
    );
    // 预置：demo 包自身 package.json（bin 字段）
    const demoPkg = path.join(paths.profileDir, 'node_modules', DEMO_NPM_PACKAGE, 'package.json');
    state.files.set(norm(demoPkg), JSON.stringify({ name: DEMO_NPM_PACKAGE, version: '0.1.1-rc.2', bin: { 'dsh-acp-demo': 'lib/bin.js' } }));

    const ctx: SetupContext = {
        homeDir: () => home,
        env: (name: string) => (name === 'DSH_HOME' ? state.envDshHome : undefined),
        exists: (p: string) => state.files.has(norm(p)),
        readFile: (p: string) => state.files.get(norm(p)) ?? null,
        writeFile: (p: string, content: string) => {
            if (state.failWritePaths?.some(f => norm(p) === norm(f))) {
                return false;
            }
            state.files.set(norm(p), content);
            return true;
        },
        mkdir: (p: string) => {
            state.files.set(norm(path.join(p, '.marker')), '');
            return true;
        },
        exec: async (program: string, args: string[], opts?: { cwd?: string }): Promise<SpawnResult> => {
            state.execCalls.push({ program, args, cwd: opts?.cwd });
            // 经 resolveExecTarget 后的 npm：node <npm-cli.js> install/view
            if (program === 'node' && args[0] === NPM_CLI_ENTRY) {
                const sub = args.slice(1);
                if (sub[0] === 'install') {
                    const pkg = sub[sub.length - 1];
                    if (pkg === 'pnpm') state.pnpmPath = 'C:/fake/npm/pnpm.cmd';
                    if (pkg === '@deepseek-ai/dsh') state.dshPath = 'C:/fake/npm/dsh.cmd';
                    return { code: 0, stdout: '', stderr: '' };
                }
                if (sub[0] === 'view') {
                    return { code: 0, stdout: JSON.stringify(state.publishedVersions), stderr: '' };
                }
                return { code: 0, stdout: '', stderr: '' };
            }
            // dsh --version
            if (args.includes('--version')) {
                return { code: 0, stdout: state.dshVersionOutput, stderr: '' };
            }
            // dsh plugin ... add ...
            if (args.includes('plugin')) {
                return { code: state.pluginAddExit, stdout: '', stderr: '' };
            }
            // pnpm install
            if (args.includes('install') || args.length === 0) {
                return { code: state.pnpmInstallExit, stdout: '', stderr: state.pnpmInstallStderr };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        npmVersions: async (): Promise<string[] | null> => state.publishedVersions,
        resolveExecutable: (program: string) => {
            if (program === 'dsh') return state.dshPath;
            if (program === 'pnpm') return state.pnpmPath;
            if (program === 'node') return 'node';
            if (program === 'npm') return NPM_CMD;
            return null;
        },
        resolveShimTarget: (shimPath: string) => {
            if (path.normalize(shimPath).toLowerCase() === path.normalize(NPM_CMD).toLowerCase()) {
                return NPM_CLI_ENTRY;
            }
            return null;
        },
    };

    return { ctx, state };
}

type MockHarness = ReturnType<typeof createMockContext> & { withOpts(o: SetupOptions): SetupOptions };
function harness(init: Partial<MockState> = {}): MockHarness {
    const { ctx, state } = createMockContext(init);
    const withOpts = (o: SetupOptions): SetupOptions => {
        const merged: SetupOptions = {
            ...o,
            onStep: (name, status, detail) => {
                state.stepLog.push({ name, status, detail });
                o.onStep?.(name, status, detail);
            },
        };
        return merged;
    };
    return { ctx, state, withOpts } as MockHarness;
}

// ==================== 纯函数 ====================

describe('parseDshVersion', () => {
    it('extracts semver from dsh output', () => {
        expect(parseDshVersion('dsh 0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
        expect(parseDshVersion('@deepseek-ai/dsh/0.1.0')).toBe('0.1.0');
    });
    it('returns unknown when no version', () => {
        expect(parseDshVersion('')).toBe('unknown');
        expect(parseDshVersion('dsh')).toBe('unknown');
    });
});

describe('defaultDemoVersionFor', () => {
    it('uses matching dsh version when available', () => {
        expect(defaultDemoVersionFor('0.1.1-rc.2')).toBe('0.1.1-rc.2');
        expect(defaultDemoVersionFor('0.1.0')).toBe('0.1.0');
    });
    it('falls back to known latest for unknown/missing', () => {
        expect(defaultDemoVersionFor('unknown')).toBe(KNOWN_DEMO_VERSIONS[0]);
        expect(defaultDemoVersionFor(null)).toBe(KNOWN_DEMO_VERSIONS[0]);
        expect(defaultDemoVersionFor(undefined)).toBe(KNOWN_DEMO_VERSIONS[0]);
        expect(defaultDemoVersionFor('   ')).toBe(KNOWN_DEMO_VERSIONS[0]);
    });
});

describe('pickDemoVersion', () => {
    it('keeps the requested version when published', () => {
        expect(pickDemoVersion('0.1.1-rc.2', ['0.1.1-rc.2', '0.1.0-rc.8'])).toBe('0.1.1-rc.2');
    });
    it('falls back to a known published version', () => {
        expect(pickDemoVersion('0.9.9', ['0.1.0-rc.8', '0.1.0-rc.7'])).toBe('0.1.0-rc.8');
    });
    it('falls back to latest published when no known version published', () => {
        expect(pickDemoVersion('0.9.9', ['9.9.9'])).toBe('9.9.9');
    });
    it('keeps requested when published list unavailable', () => {
        expect(pickDemoVersion('0.1.1-rc.2', null)).toBe('0.1.1-rc.2');
        expect(pickDemoVersion('0.1.1-rc.2', [])).toBe('0.1.1-rc.2');
    });
});

describe('buildPnpmWorkspaceYaml', () => {
    it('emits autoInstallPeers + allowBuilds koffi', () => {
        const y = buildPnpmWorkspaceYaml();
        expect(y).toContain('autoInstallPeers: true');
        expect(y).toContain('allowBuilds:');
        expect(y).toContain('  koffi: true');
    });
});

describe('mergePnpmWorkspaceYaml', () => {
    it('flips autoInstallPeers false to true', () => {
        const out = mergePnpmWorkspaceYaml('autoInstallPeers: false\n');
        expect(out).toContain('autoInstallPeers: true');
        expect(out).not.toContain('autoInstallPeers: false');
    });
    it('adds autoInstallPeers when missing', () => {
        const out = mergePnpmWorkspaceYaml('packageManager: pnpm@11.24.0\n');
        expect(out).toContain('autoInstallPeers: true');
        expect(out).toContain('packageManager: pnpm@11.24.0');
        expect(out).toContain('  koffi: true');
    });
    it('removes legacy onlyBuiltDependencies block', () => {
        const src = [
            'packageManager: pnpm@11.24.0',
            'onlyBuiltDependencies:',
            '  - koffi',
            '  - esbuild',
            'autoInstallPeers: false',
            '',
        ].join('\n');
        const out = mergePnpmWorkspaceYaml(src);
        expect(out).not.toContain('onlyBuiltDependencies');
        expect(out).not.toContain('  - koffi');
        expect(out).toContain('autoInstallPeers: true');
    });
    it('replaces existing allowBuilds block', () => {
        const out = mergePnpmWorkspaceYaml('allowBuilds:\n  esbuild: true\n');
        expect(out).not.toContain('esbuild: true');
        expect(out).toContain('  koffi: true');
    });
    it('handles empty/blank input', () => {
        expect(mergePnpmWorkspaceYaml('')).toContain('autoInstallPeers: true');
        expect(mergePnpmWorkspaceYaml('   ')).toContain('autoInstallPeers: true');
    });
});

describe('normalizeProfilePackageJson', () => {
    it('drops the pnpm field', () => {
        const src = JSON.stringify({ name: 'acp', pnpm: { overrides: {} } });
        const out = normalizeProfilePackageJson(src);
        expect(JSON.parse(out)).toEqual({ name: 'acp' });
    });
    it('strips a leading BOM', () => {
        const src = '\uFEFF' + JSON.stringify({ name: 'acp', pnpm: {} });
        const out = normalizeProfilePackageJson(src);
        expect(out.startsWith('\uFEFF')).toBe(false);
        expect(JSON.parse(out).name).toBe('acp');
    });
    it('returns content unchanged for non-JSON', () => {
        expect(normalizeProfilePackageJson('not json')).toBe('not json');
    });
    it('pretty-prints JSON', () => {
        const out = normalizeProfilePackageJson('{"a":1}');
        expect(out).toContain('\n');
    });
});

describe('buildCordisYml', () => {
    it('emits plugin tree with model, provider, persistenceRoot', () => {
        const y = buildCordisYml({ model: 'deepseek-v4-flash', provider: 'deepseek-official', persistenceRoot: 'C:\\Users\\x\\.dsh\\profiles\\acp\\.sessions' });
        expect(y.trimStart().startsWith('- id: llm-deepseek')).toBe(true);
        expect(y).toContain('provider: deepseek-official');
        expect(y).toContain('model: deepseek-v4-flash');
        expect(y).toContain('persistenceRoot: C:\\Users\\x\\.dsh\\profiles\\acp\\.sessions');
        expect(y).toContain("name: '@deepseek-ai/dsh-acp-demo'");
        expect(y).toContain('workspaceContext: false');
    });

    it('mounts the file-access tool stack so sessions can read/write/search the vault', () => {
        const y = buildCordisYml({ model: 'deepseek-v4-flash', provider: 'deepseek-official', persistenceRoot: 'C:\\.dsh\\.sessions' });
        // subprocess 底座（grep/glob 执行）＋ 文件工具三件套
        expect(y).toContain("- id: subprocess");
        expect(y).toContain("name: '@deepseek-ai/dsh-subprocess-local'");
        expect(y).toContain("- id: tool-fs");
        expect(y).toContain("name: '@deepseek-ai/dsh-tool-fs'");
        expect(y).toContain("- id: tool-fs-search");
        expect(y).toContain("name: '@deepseek-ai/dsh-tool-fs-search'");
        expect(y).toContain('sampleOverCapGlobResults: false');
        // tool-fs-search 必须在 subprocess 就绪后才会激活，其条目排布在 acp-demo 之前
        const subprocessIdx = y.indexOf('- id: subprocess');
        const fsIdx = y.indexOf('- id: tool-fs');
        const searchIdx = y.indexOf('- id: tool-fs-search');
        const acpIdx = y.indexOf('- id: acp-demo');
        expect(subprocessIdx).toBeGreaterThan(-1);
        expect(fsIdx).toBeGreaterThan(subprocessIdx);
        expect(searchIdx).toBeGreaterThan(fsIdx);
        expect(acpIdx).toBeGreaterThan(searchIdx);
    });
});

describe('computeProfilePaths', () => {
    it('defaults to ~/.dsh', () => {
        const p = computeProfilePaths('C:/Users/x');
        expect(p.dshHome).toBe(path.join('C:/Users/x', '.dsh'));
        expect(p.profileDir).toBe(path.join('C:/Users/x', '.dsh', 'profiles', 'acp'));
        expect(p.cordisPath).toBe(path.join(p.profileDir, 'cordis.yml'));
        expect(p.sessionsRoot).toBe(path.join(p.profileDir, '.sessions'));
    });
    it('honors DSH_HOME', () => {
        const p = computeProfilePaths('C:/Users/x', 'D:/dsh-home');
        expect(p.dshHome).toBe('D:/dsh-home');
        expect(p.profileDir).toBe(path.join('D:/dsh-home', 'profiles', 'acp'));
    });
});

// ==================== runBackendSetup 编排 ====================

describe('runBackendSetup', () => {
    it('happy path returns ok with acpCommand and all steps', async () => {
        const h = harness();
        const res: SetupResult = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
        expect(res.acpCommand).toContain('dsh-acp-demo');
        expect(res.acpCommand).toContain('-c ');
        // 步骤齐全且全 ok
        const names = res.steps.map(s => s.name);
        expect(names).toContain('检测 dsh');
        expect(names).toContain('确定配套 demo 版本');
        expect(names).toContain('装配 demo 到 acp profile');
        expect(names).toContain('配置 pnpm workspace');
        expect(names).toContain('安装依赖并编译 koffi');
        expect(names).toContain('生成 cordis.yml');
        expect(res.steps.every(s => s.ok)).toBe(true);
        expect(h.state.stepLog.some(s => s.status === 'ok')).toBe(true);
    });

    it('writes cordis.yml with absolute sessions root', async () => {
        const h = harness();
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        const paths = computeProfilePaths(h.ctx.homeDir(), h.ctx.env('DSH_HOME'));
        const cordis = h.state.files.get(norm(paths.cordisPath));
        expect(cordis).toBeDefined();
        expect(cordis).toContain(paths.sessionsRoot);
    });

    it('fails fast when dsh missing and no install authorized', async () => {
        const h = harness({ dshPath: null });
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('未找到 dsh');
        expect(res.steps[0].ok).toBe(false);
    });

    it('installs dsh when authorized (npm via node <npm-cli.js> shim, not bare cmd)', async () => {
        if (process.platform !== 'win32') return; // Windows 专属：npm 是 .cmd shim 须经 node 直启
        const h = harness({ dshPath: null });
        const res = await runBackendSetup(h.ctx, h.withOpts({ allowInstallDsh: true }));
        expect(res.ok).toBe(true);
        const npmInstall = h.state.execCalls.find(c => c.args.includes('install') && c.args.some(a => a.includes('npm-cli.js')));
        expect(npmInstall).toBeDefined();
        expect(npmInstall?.program).toBe('node');
        expect(npmInstall?.args[0]).toBe(NPM_CLI_ENTRY);
        expect(npmInstall?.args).toContain('@deepseek-ai/dsh');
    });

    it('installs pnpm when missing and authorized (npm via node <npm-cli.js> shim)', async () => {
        if (process.platform !== 'win32') return; // Windows 专属：npm 是 .cmd shim 须经 node 直启
        const h = harness({ pnpmPath: null });
        const res = await runBackendSetup(h.ctx, h.withOpts({ allowInstallPnpm: true }));
        expect(res.ok).toBe(true);
        const npmInstall = h.state.execCalls.find(c => c.args.includes('install') && c.args.some(a => a.includes('npm-cli.js')));
        expect(npmInstall).toBeDefined();
        expect(npmInstall?.program).toBe('node');
        expect(npmInstall?.args).toContain('pnpm');
    });

    it('fails when pnpm missing and not authorized', async () => {
        const h = harness({ pnpmPath: null });
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('pnpm');
    });

    it('accepts ERR_PNPM_IGNORED_BUILDS warning as success', async () => {
        const h = harness({ pnpmInstallExit: 1, pnpmInstallStderr: 'ERR_PNPM_IGNORED_BUILDS koffi' });
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(true);
        const step = res.steps.find(s => s.name === '安装依赖并编译 koffi');
        expect(step?.ok).toBe(true);
    });

    it('fails on real pnpm install error', async () => {
        const h = harness({ pnpmInstallExit: 1, pnpmInstallStderr: 'ELIFECYCLE failed' });
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('pnpm install 失败');
    });

    it('tolerates dsh plugin add non-zero when demo already recorded', async () => {
        const h = harness({ pluginAddExit: 1 });
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(true);
    });

    it('fails when plugin add fails and demo not recorded', async () => {
        const h = harness({ pluginAddExit: 1 });
        // 抹掉预置的 package.json，模拟 demo 未装配成功
        const paths = computeProfilePaths(h.ctx.homeDir(), h.ctx.env('DSH_HOME'));
        h.state.files.delete(norm(paths.packageJsonPath));
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(false);
        expect(res.error).toContain('dsh plugin add 失败');
    });

    it('resolves demo version against published list', async () => {
        const h = harness({ dshVersionOutput: 'dsh 9.9.9-rc.99\n' });
        // 9.9.9-rc.99 未发布 → 回落到已知已发布版本
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(true);
        const step = res.steps.find(s => s.name === '确定配套 demo 版本');
        expect(step?.detail).toContain('0.1.1-rc.2');
    });

    it('honors explicit demoVersion option', async () => {
        const h = harness({ publishedVersions: ['0.1.0-rc.7', '0.1.0-rc.8'] });
        const res = await runBackendSetup(h.ctx, h.withOpts({ demoVersion: '0.1.0-rc.8' }));
        expect(res.ok).toBe(true);
        expect(h.state.execCalls.some(c => c.args.join(' ').includes('@deepseek-ai/dsh-acp-demo@0.1.0-rc.8'))).toBe(true);
    });

    it('rejects model/provider with illegal chars (YAML injection guard)', async () => {
        const h = harness();
        const res = await runBackendSetup(h.ctx, h.withOpts({ model: 'bad\n- id: injected' }));
        expect(res.ok).toBe(false);
        expect(res.errorCode).toBe('INSTALL_FAILED');
    });

    it('reports errorCode NO_DSH / NO_PNPM for structured branching', async () => {
        const h1 = harness({ dshPath: null });
        const r1 = await runBackendSetup(h1.ctx, h1.withOpts({}));
        expect(r1.errorCode).toBe('NO_DSH');

        const h2 = harness({ pnpmPath: null });
        const r2 = await runBackendSetup(h2.ctx, h2.withOpts({}));
        expect(r2.errorCode).toBe('NO_PNPM');
    });

    it('fails with WRITE_FAILED when cordis.yml cannot be written (no false success)', async () => {
        const h = harness();
        const paths = computeProfilePaths(h.ctx.homeDir(), h.ctx.env('DSH_HOME'));
        h.state.failWritePaths = [paths.cordisPath];
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        expect(res.ok).toBe(false);
        expect(res.errorCode).toBe('WRITE_FAILED');
        expect(res.steps.some(s => s.name === '生成 cordis.yml' && !s.ok)).toBe(true);
    });
});

// ==================== npm shim 直启（mock 保真） ====================

describe('resolveExecTarget npm shim fidelity', () => {
    it('resolves npm.cmd to node <npm-cli.js> (no cmd.exe / GBK)', () => {
        if (process.platform !== 'win32') return; // Windows 专属：.cmd shim 转 node 直启
        const h = harness();
        const t = resolveExecTarget(h.ctx, 'npm');
        expect(t.program).toBe('node');
        expect(t.args[0]).toBe(NPM_CLI_ENTRY);
    });
});

// ==================== computeAcpCommand ====================

describe('computeAcpCommand', () => {
    it('builds node <bin> -c <cordis> from demo package.json bin field', async () => {
        const h = harness();
        const res = await runBackendSetup(h.ctx, h.withOpts({}));
        // 生成命令必须能经 splitCommand 还原为 node <bin> -c <cordis>
        const { program, args } = splitCommand(res.acpCommand!);
        expect(program).toBe('node');
        expect(args[0]).toContain('dsh-acp-demo');
        expect(args[0]).toContain('bin.js');
        expect(args[1]).toBe('-c');
        expect(args[2]).toContain('cordis.yml');
        expect(args).toHaveLength(3);
    });
    it('falls back to lib/bin.js when package.json unreadable', async () => {
        const h = harness();
        const paths = computeProfilePaths(h.ctx.homeDir(), h.ctx.env('DSH_HOME'));
        h.state.files.delete(norm(path.join(paths.profileDir, 'node_modules', DEMO_NPM_PACKAGE, 'package.json')));
        const cmd = computeAcpCommand(h.ctx, paths);
        const { program, args } = splitCommand(cmd);
        expect(program).toBe('node');
        expect(args[0]).toContain('bin.js');
        expect(args[1]).toBe('-c');
    });

    it('emits forward-slash paths so spawned argv matches on-disk (no doubled backslashes)', () => {
        const h = harness();
        // 用真实 Windows 风格反斜杠路径（含空格目录）构造 ProfilePaths
        const profileDir = 'C:\\Users\\John Smith\\.dsh\\profiles\\acp';
        const paths = {
            dshHome: 'C:\\Users\\John Smith\\.dsh',
            profileDir,
            cordisPath: path.join(profileDir, 'cordis.yml'),
            packageJsonPath: path.join(profileDir, 'package.json'),
            workspaceYamlPath: path.join(profileDir, 'pnpm-workspace.yaml'),
            sessionsRoot: path.join(profileDir, '.sessions'),
        };
        // 预置 demo package.json（bin: lib/bin.js）
        h.state.files.set(
            norm(path.join(profileDir, 'node_modules', DEMO_NPM_PACKAGE, 'package.json')),
            JSON.stringify({ bin: { 'dsh-acp-demo': 'lib/bin.js' } }),
        );
        const cmd = computeAcpCommand(h.ctx, paths);
        const { args } = splitCommand(cmd);
        // bin 参数不含转义出的双反斜杠，且为磁盘路径的正斜杠形态
        expect(args[0]).not.toContain('\\\\');
        expect(args[0]).toBe(path.join(profileDir, 'node_modules', DEMO_NPM_PACKAGE, 'lib', 'bin.js').replace(/\\/g, '/'));
        expect(args[2]).toBe(path.join(profileDir, 'cordis.yml').replace(/\\/g, '/'));
    });
});

// ==================== resolveExecTarget ====================

describe('resolveExecTarget', () => {
    it('passes through plain executables', () => {
        const h = harness();
        const t = resolveExecTarget(h.ctx, 'C:/tools/dsh.exe');
        expect(t.program).toBe('C:/tools/dsh.exe');
        expect(t.args).toEqual([]);
    });
    it('resolves .ps1 through powershell.exe', () => {
        if (process.platform !== 'win32') return; // Windows 专属：.ps1 经 powershell.exe 启动
        const h = harness();
        const t = resolveExecTarget(h.ctx, 'C:/tools/setup.ps1');
        expect(t.program).toBe('powershell.exe');
        expect(t.args).toContain('-File');
    });
    it('resolves .cmd shim to node <entry> when shim target found', () => {
        if (process.platform !== 'win32') return; // Windows 专属：.cmd shim 转 node <entry> 直启
        const state = { dshPath: 'C:/tools/dsh.cmd' } as MockState;
        const { ctx } = createMockContext(state);
        // 覆盖 resolveShimTarget 模拟找到真实入口
        (ctx as unknown as { resolveShimTarget: (p: string) => string | null }).resolveShimTarget = () => 'C:/tools/node_modules/dsh/lib/bin.js';
        const t = resolveExecTarget(ctx, 'C:/tools/dsh.cmd');
        expect(t.program).toBe('node');
        expect(t.args[0]).toBe('C:/tools/node_modules/dsh/lib/bin.js');
    });
});
