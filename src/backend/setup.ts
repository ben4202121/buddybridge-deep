// ==================== 一键配置 DSH ACP 后端 (Phase 1.1) ====================
// 把 scripts/setup-acp.ps1 的逻辑移植为跨平台 TS 模块，供设置页「一键配置后端」按钮调用。
// 纯函数直接可测；执行侧通过注入的 SetupContext 提供 fs / 进程 / npm 查询能力，
// 单测用内存 mock，不触发真实网络与安装。
//
// 流程（对应 setup-acp.ps1）：
//   探测 dsh → 确定配套 demo 版本 → dsh plugin add demo → 写 pnpm-workspace.yaml
//   → 归一化 package.json（无 BOM）→ pnpm install（编译 koffi）→ 写 cordis.yml
//   → 组装 ACP 命令（node <demo>/lib/bin.js -c <cordis.yml>）

import * as path from 'path';

// ==================== 常量 ====================

/** 已知可用的 demo 版本（新→旧）。dsh 与 demo 版本号同轨（0.1.1-rc.2 ↔ 0.1.1-rc.2）。 */
export const KNOWN_DEMO_VERSIONS = [
    '0.1.1-rc.2',
    '0.1.1-rc.1',
    '0.1.0-rc.8',
    '0.1.0-rc.7',
] as const;

export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_PROVIDER = 'deepseek-official';
export const DSH_NPM_PACKAGE = '@deepseek-ai/dsh';
export const DEMO_NPM_PACKAGE = '@deepseek-ai/dsh-acp-demo';

/** model/provider 写入 cordis.yml 前须通过白名单校验（防 YAML 注入到用户自己的 profile）。 */
const MODEL_PROVIDER_RE = /^[A-Za-z0-9._-]+$/;

// ==================== 纯函数 ====================

/** 解析 `dsh --version` 输出中的版本号；无法解析返回 'unknown'。 */
export function parseDshVersion(output: string): string {
    const m = String(output).trim().match(/(\d+\.\d+\.\d+(?:[-.][\w.]+)*)/);
    return m ? m[1] : 'unknown';
}

/** dsh 版本 → 配套 demo 版本（版本号同轨）；未知时回落已知可用第一个。 */
export function defaultDemoVersionFor(dshVersion: string | null | undefined): string {
    const v = (dshVersion || '').trim();
    if (v && v !== 'unknown' && /^\d+\.\d+\.\d+/.test(v)) {
        return v;
    }
    return KNOWN_DEMO_VERSIONS[0];
}

/** 在已知版本列表里挑选一个可用的 demo 版本；未发布版本剔除。 */
export function pickDemoVersion(demoVersion: string, published: string[] | null): string {
    if (!published || published.length === 0) return demoVersion;
    if (published.includes(demoVersion)) return demoVersion;
    const fallback = KNOWN_DEMO_VERSIONS.find(v => published.includes(v))
        ?? published[published.length - 1];
    return fallback || demoVersion;
}

/** 生成 pnpm-workspace.yaml（pnpm 11：autoInstallPeers + allowBuilds koffi）。 */
export function buildPnpmWorkspaceYaml(): string {
    return [
        'autoInstallPeers: true',
        '',
        'allowBuilds:',
        '  koffi: true',
        '',
    ].join('\n');
}

/**
 * 合并已有 pnpm-workspace.yaml：
 * 去掉旧的 onlyBuiltDependencies / allowBuilds 块、autoInstallPeers:false → true，
 * 缺 autoInstallPeers 时补上，末尾追加 allowBuilds.koffi。其余行（packageManager 等）原样保留。
 */
export function mergePnpmWorkspaceYaml(existing: string): string {
    const lines = (existing || '').split(/\r?\n/);
    const out: string[] = [];
    let skipping: 'onlyBuiltDependencies' | 'allowBuilds' | null = null;
    let hasAutoInstallPeers = false;
    for (const line of lines) {
        if (skipping) {
            if (/^\s/.test(line) || line.trim() === '') continue;
            skipping = null;
        }
        if (/^\s*onlyBuiltDependencies\s*:/.test(line)) { skipping = 'onlyBuiltDependencies'; continue; }
        if (/^\s*allowBuilds\s*:/.test(line)) { skipping = 'allowBuilds'; continue; }
        if (/^\s*autoInstallPeers\s*:/.test(line)) {
            hasAutoInstallPeers = true;
            out.push(line.replace(/:\s*false.*/, ': true'));
            continue;
        }
        out.push(line);
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (!hasAutoInstallPeers) out.unshift('autoInstallPeers: true');
    return [...out, '', 'allowBuilds:', '  koffi: true', ''].join('\n');
}

/**
 * 归一化 profile package.json：删除 pnpm 字段，输出 UTF-8 无 BOM。
 * （BOM 会让 dsh 的 JSON.parse 抛 "Unexpected token '<feff>'"；pnpm 11 的 allowBuilds 已移到 workspace yaml）
 */
export function normalizeProfilePackageJson(content: string): string {
    const cleaned = content.replace(/^\uFEFF/, '');
    let obj: unknown;
    try {
        obj = JSON.parse(cleaned);
    } catch {
        return content; // 非 JSON：原样返回，不销毁未知文件
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return content;
    const rec = obj as Record<string, unknown>;
    delete rec.pnpm;
    return JSON.stringify(rec, null, 2);
}

/** cordis.yml 内容参数。 */
export interface CordisOptions {
    model: string;
    provider: string;
    /** 绝对路径，直接写入（Windows 反斜杠原样保留，YAML 明文标量可接受）。 */
    persistenceRoot: string;
}

/** 生成 cordis.yml（顶层插件树；供 demo bin `-c` 使用）。 */
export function buildCordisYml(opts: CordisOptions): string {
    const { model, provider, persistenceRoot } = opts;
    return [
        '- id: llm-deepseek',
        "  name: '@deepseek-ai/dsh-llm-deepseek'",
        '  config:',
        '    thinking: enabled',
        '    models:',
        `      - id: ${model}`,
        '- id: system-prompt',
        "  name: '@deepseek-ai/dsh-system-prompt'",
        '  config:',
        '    persona: >-',
        '      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}.',
        '- id: agent-instructions',
        "  name: '@deepseek-ai/dsh-agent-instructions'",
        '  config:',
        '    maxBytes: 65536',
        '- id: sandbox-policy',
        "  name: '@deepseek-ai/dsh-sandbox-policy'",
        '  config:',
        '    mode: workspace-write',
        '    workspaceRoot: !!js process.cwd()',
        '- id: approval',
        "  name: '@deepseek-ai/dsh-user-approval'",
        '  config:',
        '    policy: ask',
        '- id: fs-sandbox',
        "  name: '@deepseek-ai/dsh-fs-sandbox'",
        '  config:',
        '    cwd: !!js process.cwd()',
        '- id: acp-demo',
        "  name: '@deepseek-ai/dsh-acp-demo'",
        '  config:',
        `    provider: ${provider}`,
        `    model: ${model}`,
        `    persistenceRoot: ${persistenceRoot}`,
        '    workspaceContext: false',
        '',
    ].join('\n');
}

/** profile 相关路径集合。 */
export interface ProfilePaths {
    dshHome: string;
    profileDir: string;
    cordisPath: string;
    packageJsonPath: string;
    workspaceYamlPath: string;
    sessionsRoot: string;
}

/** 计算 profile 路径（DSH_HOME 环境变量优先，缺省 ~/.dsh）。 */
export function computeProfilePaths(homeDir: string, envDshHome?: string): ProfilePaths {
    const dshHome = envDshHome && envDshHome.trim()
        ? envDshHome.trim()
        : path.join(homeDir, '.dsh');
    const profileDir = path.join(dshHome, 'profiles', 'acp');
    return {
        dshHome,
        profileDir,
        cordisPath: path.join(profileDir, 'cordis.yml'),
        packageJsonPath: path.join(profileDir, 'package.json'),
        workspaceYamlPath: path.join(profileDir, 'pnpm-workspace.yaml'),
        sessionsRoot: path.join(profileDir, '.sessions'),
    };
}

// ==================== 执行上下文（可注入，便于测试） ====================

export interface SpawnResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface SetupContext {
    homeDir(): string;
    env(name: string): string | undefined;
    exists(p: string): boolean;
    readFile(p: string): string | null;
    writeFile(p: string, content: string): boolean;
    mkdir(p: string): boolean;
    /** 执行命令（非 shell），等待结束并捕获输出。 */
    exec(program: string, args: string[], opts?: { cwd?: string }): Promise<SpawnResult>;
    /** 查询 npm 包已发布版本（失败返回 null）。 */
    npmVersions(pkg: string): Promise<string[] | null>;
    /** 解析可执行文件（复用 cli.resolveExecutable 语义）。 */
    resolveExecutable(program: string): string | null;
    /** 解析 .cmd/.bat shim 的真实 JS 入口（复用 cli.resolveShimTarget 语义）。 */
    resolveShimTarget(shimPath: string): string | null;
}

/** 把可执行路径解析为可直接 spawn 的 {program, args}（.cmd/.bat → node <entry> 绕开 cmd.exe）。 */
export function resolveExecTarget(ctx: SetupContext, program: string): { program: string; args: string[] } {
    const resolved = ctx.resolveExecutable(program) || program;
    const ext = path.extname(resolved).toLowerCase();
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
        const entry = ctx.resolveShimTarget(resolved);
        if (entry) {
            const node = ctx.resolveExecutable('node') || 'node';
            return { program: node, args: [entry] };
        }
    }
    if (process.platform === 'win32' && ext === '.ps1') {
        return {
            program: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved],
        };
    }
    return { program: resolved, args: [] };
}

// ==================== 编排 ====================

export type SetupStepStatus = 'running' | 'ok' | 'fail';

export interface SetupStep {
    name: string;
    ok: boolean;
    detail?: string;
}

export interface SetupOptions {
    model?: string;
    provider?: string;
    demoVersion?: string;
    /** 允许 `npm install -g pnpm`（UI 由确认框授权后置 true；默认 false）。 */
    allowInstallPnpm?: boolean;
    /** 允许 `npm install -g @deepseek-ai/dsh`（默认 false）。 */
    allowInstallDsh?: boolean;
    onStep?: (name: string, status: SetupStepStatus, detail?: string) => void;
}

export interface SetupResult {
    ok: boolean;
    steps: SetupStep[];
    /** 成功后可直接写入设置项 acpCommand 的启动命令。 */
    acpCommand?: string;
    error?: string;
    /** 稳定错误码，供 UI 做结构化分支（避免匹配文案）。 */
    errorCode?: 'NO_DSH' | 'NO_PNPM' | 'INSTALL_FAILED' | 'PLUGIN_ADD_FAILED' | 'PNPM_INSTALL_FAILED' | 'WRITE_FAILED';
}

/** 把 pnpm install 输出中可接受的警告单独挑出（ERR_PNPM_IGNORED_BUILDS 不算失败）。 */
function isAcceptablePnpmFailure(stdout: string, stderr: string): boolean {
    return /ERR_PNPM_IGNORED_BUILDS/.test(`${stdout}\n${stderr}`);
}

/** 执行 dsh 命令（返回实际 exit code；null 表示无法解析时按 1 处理）。 */
async function execDsh(ctx: SetupContext, dshPath: string, args: string[], cwd?: string): Promise<SpawnResult> {
    const target = resolveExecTarget(ctx, dshPath);
    return ctx.exec(target.program, [...target.args, ...args], cwd ? { cwd } : undefined);
}

/**
 * 一键配置后端主流程。执行顺序与 setup-acp.ps1 一致。
 * 所有写盘/全局安装均发生在调用方（UI）已确认的前提下。
 */
export async function runBackendSetup(ctx: SetupContext, opts: SetupOptions = {}): Promise<SetupResult> {
    const model = opts.model || DEFAULT_MODEL;
    const provider = opts.provider || DEFAULT_PROVIDER;
    const steps: SetupStep[] = [];
    const report = (name: string, ok: boolean, detail?: string) => {
        steps.push({ name, ok, detail });
        opts.onStep?.(name, ok ? 'ok' : 'fail', detail);
    };

    // 写入 cordis.yml 前校验 model/provider（防 YAML 注入）
    if (!MODEL_PROVIDER_RE.test(model) || !MODEL_PROVIDER_RE.test(provider)) {
        report('校验配置', false, 'model/provider 包含非法字符');
        return { ok: false, steps, error: 'model/provider 参数非法', errorCode: 'INSTALL_FAILED' };
    }

    // ---- 0. 探测 / 安装 dsh ----
    let dshPath = ctx.resolveExecutable('dsh');
    if (!dshPath) {
        if (opts.allowInstallDsh) {
            opts.onStep?.('安装 dsh', 'running');
            // npm 在 Windows 是 .cmd shim，须经 resolveExecTarget 转 node <npm-cli.js> 直启
            const npmTarget = resolveExecTarget(ctx, 'npm');
            const inst = await ctx.exec(npmTarget.program, [...npmTarget.args, 'install', '-g', DSH_NPM_PACKAGE]);
            if (inst.code !== 0) {
                report('安装 dsh', false, (inst.stderr || inst.stdout || 'npm install 失败').substring(0, 300));
                return { ok: false, steps, error: '无法安装 dsh', errorCode: 'INSTALL_FAILED' };
            }
            dshPath = ctx.resolveExecutable('dsh');
            if (!dshPath) {
                report('安装 dsh', false, '安装后仍找不到 dsh');
                return { ok: false, steps, error: 'dsh 安装后不可用', errorCode: 'INSTALL_FAILED' };
            }
        } else {
            report('检测 dsh', false, `未找到 dsh。请先安装：npm install -g ${DSH_NPM_PACKAGE}，或允许插件自动安装。`);
            return { ok: false, steps, error: '未找到 dsh', errorCode: 'NO_DSH' };
        }
    }
    report('检测 dsh', true, dshPath);

    // ---- 1. 确定配套 demo 版本 ----
    opts.onStep?.('确定配套 demo 版本', 'running');
    let dshVersion = 'unknown';
    const verRes = await execDsh(ctx, dshPath, ['--version']);
    if (verRes.code === 0) dshVersion = parseDshVersion(verRes.stdout);
    let demoVersion = opts.demoVersion || defaultDemoVersionFor(dshVersion);
    const published = await ctx.npmVersions(DEMO_NPM_PACKAGE);
    demoVersion = pickDemoVersion(demoVersion, published);
    report('确定配套 demo 版本', true, `dsh=${dshVersion} → ${DEMO_NPM_PACKAGE}@${demoVersion}`);

    // ---- 2. profile 目录 + dsh plugin add demo ----
    const paths = computeProfilePaths(ctx.homeDir(), ctx.env('DSH_HOME'));
    if (!ctx.exists(paths.profileDir) && !ctx.mkdir(paths.profileDir)) {
        report('装配 demo 到 acp profile', false, `无法创建目录：${paths.profileDir}`);
        return { ok: false, steps, error: '无法创建 profile 目录', errorCode: 'WRITE_FAILED' };
    }
    opts.onStep?.('装配 demo 到 acp profile', 'running');
    const addRes = await execDsh(ctx, dshPath, ['plugin', '--profile', 'acp', 'add', `${DEMO_NPM_PACKAGE}@${demoVersion}`]);
    const pkgRawAfter = ctx.readFile(paths.packageJsonPath);
    // 失败时只容忍"已记录同版本 demo"（避免把上一次装的旧版本误判为本次成功）
    const demoVersionRecorded = !!pkgRawAfter && pkgRawAfter.includes(demoVersion);
    if (addRes.code !== 0 && !demoVersionRecorded) {
        report('装配 demo 到 acp profile', false, (addRes.stderr || addRes.stdout || 'dsh plugin add 失败').substring(0, 300));
        return { ok: false, steps, error: 'dsh plugin add 失败', errorCode: 'PLUGIN_ADD_FAILED' };
    }
    report('装配 demo 到 acp profile', true, demoVersionRecorded ? `package.json 已记录 ${demoVersion}` : '命令已执行');

    // ---- 3. pnpm-workspace.yaml ----
    const wsRaw = ctx.readFile(paths.workspaceYamlPath);
    // 已有内容时合并保留其他配置（packageManager 等）；首次直接写基础模板
    const wsWritten = ctx.writeFile(
        paths.workspaceYamlPath,
        wsRaw !== null ? mergePnpmWorkspaceYaml(wsRaw) : buildPnpmWorkspaceYaml(),
    );
    if (!wsWritten) {
        report('配置 pnpm workspace', false, `写入失败：${paths.workspaceYamlPath}`);
        return { ok: false, steps, error: '无法写入 pnpm-workspace.yaml', errorCode: 'WRITE_FAILED' };
    }
    report('配置 pnpm workspace', true, 'autoInstallPeers + allowBuilds.koffi');

    // ---- 4. 归一化 package.json（无 BOM） ----
    const pkgRaw = ctx.readFile(paths.packageJsonPath);
    if (pkgRaw !== null) {
        if (!ctx.writeFile(paths.packageJsonPath, normalizeProfilePackageJson(pkgRaw))) {
            report('归一化 profile package.json', false, `写入失败：${paths.packageJsonPath}`);
            return { ok: false, steps, error: '无法写入 profile package.json', errorCode: 'WRITE_FAILED' };
        }
    }
    report('归一化 profile package.json', true, pkgRaw !== null ? 'UTF-8 无 BOM' : 'package.json 不存在，跳过');

    // ---- 5. pnpm install（编译 koffi） ----
    opts.onStep?.('安装依赖并编译 koffi', 'running');
    let pnpmPath = ctx.resolveExecutable('pnpm');
    if (!pnpmPath) {
        if (opts.allowInstallPnpm) {
            const npmTarget = resolveExecTarget(ctx, 'npm');
            const pnpmInst = await ctx.exec(npmTarget.program, [...npmTarget.args, 'install', '-g', 'pnpm']);
            if (pnpmInst.code !== 0) {
                report('安装 pnpm', false, (pnpmInst.stderr || pnpmInst.stdout || '失败').substring(0, 300));
                return { ok: false, steps, error: '无法安装 pnpm', errorCode: 'INSTALL_FAILED' };
            }
            pnpmPath = ctx.resolveExecutable('pnpm');
        }
    }
    if (!pnpmPath) {
        report('安装依赖并编译 koffi', false, '未找到 pnpm，且未授权自动安装');
        return { ok: false, steps, error: '未找到 pnpm', errorCode: 'NO_PNPM' };
    }
    const pnpmTarget = resolveExecTarget(ctx, pnpmPath);
    const pnpmRes = await ctx.exec(pnpmTarget.program, [...pnpmTarget.args, 'install'], { cwd: paths.profileDir });
    if (pnpmRes.code !== 0 && !isAcceptablePnpmFailure(pnpmRes.stdout, pnpmRes.stderr)) {
        report('安装依赖并编译 koffi', false, (pnpmRes.stderr || pnpmRes.stdout || 'pnpm install 失败').substring(0, 400));
        return { ok: false, steps, error: 'pnpm install 失败', errorCode: 'PNPM_INSTALL_FAILED' };
    }
    report('安装依赖并编译 koffi', true, pnpmRes.code === 0 ? 'pnpm install 完成' : '完成（仅 ERR_PNPM_IGNORED_BUILDS 警告）');

    // ---- 6. 写 cordis.yml ----
    if (!ctx.writeFile(paths.cordisPath, buildCordisYml({ model, provider, persistenceRoot: paths.sessionsRoot }))) {
        report('生成 cordis.yml', false, `写入失败：${paths.cordisPath}`);
        return { ok: false, steps, error: '无法写入 cordis.yml', errorCode: 'WRITE_FAILED' };
    }
    report('生成 cordis.yml', true, paths.cordisPath);

    // ---- 7. 组装 ACP 命令 ----
    const acpCommand = computeAcpCommand(ctx, paths);
    report('组装 ACP 命令', true, acpCommand);

    return { ok: true, steps, acpCommand };
}

/** 从已装配的 profile 组装 ACP 启动命令：node <demo>/lib/bin.js -c <cordis.yml>。 */
export function computeAcpCommand(ctx: SetupContext, paths: ProfilePaths): string {
    const demoDir = path.join(paths.profileDir, 'node_modules', DEMO_NPM_PACKAGE);
    let binPath = path.join(demoDir, 'lib', 'bin.js');
    const pkgRaw = ctx.readFile(path.join(demoDir, 'package.json'));
    if (pkgRaw) {
        try {
            const bin = (JSON.parse(pkgRaw) as { bin?: unknown }).bin;
            if (typeof bin === 'string') {
                binPath = path.join(demoDir, bin);
            } else if (bin && typeof bin === 'object') {
                const b = bin as Record<string, unknown>;
                const v = b['dsh-acp-demo'] ?? Object.values(b)[0];
                if (typeof v === 'string') binPath = path.join(demoDir, v);
            }
        } catch { /* 保持默认 lib/bin.js */ }
    }
    // 用裸 `node`（不用绝对路径）：生成命令要能被 resolveAcpCommand → splitCommand 还原，
    // 绝对路径含空格（C:/Program Files/...）会被 splitCommand 误拆；且 dsh 本身依赖 node，
    // 能跑 ACP 就必然有 node 在 PATH。
    // 路径统一转正斜杠：JSON.stringify 不会再转义反斜杠，spawn 后 argv 与磁盘路径逐字符一致
    // （反斜杠路径会变成双反斜杠，demo 侧做字符串比较/相对路径会出错）。
    const binArg = binPath.replace(/\\/g, '/');
    const cordisArg = paths.cordisPath.replace(/\\/g, '/');
    return `node ${JSON.stringify(binArg)} -c ${JSON.stringify(cordisArg)}`;
}
