// ==================== DeepSeek Harness ACP 适配层 (方案 §3.2) ====================
// 通过 ACP (Agent Client Protocol) stdio JSON-RPC 与 DeepSeek Harness 通信。
// 启动命令可配置（默认 "dsh --profile acp"），cwd = Vault 根路径。

import * as path from 'path';
import * as fs from 'fs';
import { AcpClient, type AcpClientOptions, type AcpTransport } from './acp-client';
import { getErrorMessage, isObject, getString } from '../../types';
import type { StreamChunk } from '../../core/stream-chunk';
import type {
    BridgeAdapter,
    BridgeCapabilities,
    BridgeConfig,
    DiagnosticCheck,
    DiagnosticResult,
    PermissionRequest,
    PermissionResponse,
    UserMessage,
    VaultContext,
} from '../../core/bridge-adapter';

// ==================== 命令解析（可单测） ====================

/** 将命令行字符串拆分为 program + args，支持双引号包裹的参数。 */
export function splitCommand(command: string): { program: string; args: string[] } {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let started = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (ch === '"') {
            inQuote = !inQuote;
            started = true;
        } else if ((ch === ' ' || ch === '\t') && !inQuote) {
            if (started) {
                tokens.push(current);
                current = '';
                started = false;
            }
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) tokens.push(current);
    const program = tokens[0] ?? '';
    return { program, args: tokens.slice(1) };
}

function fileExists(p: string): boolean {
    try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** 在 PATH 中解析可执行文件（Windows 按优先级找 .exe/.cmd/.bat/.ps1，无扩展名 shim 最后兜底）。 */
export function resolveExecutable(program: string): string | null {
    if (!program) return null;
    if (path.isAbsolute(program)) {
        return fileExists(program) ? program : null;
    }
    if (path.extname(program)) {
        if (fileExists(program)) return program;
    }
    // 无扩展名的 npm shim（如 ...\npm\dsh）在 Windows 上无法被 Node spawn，必须排在最后
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    // Windows npm 全局 shim 目录兜底
    if (process.platform === 'win32' && process.env.APPDATA) {
        dirs.push(path.join(process.env.APPDATA, 'npm'));
    }
    for (const dir of dirs) {
        for (const ext of exts) {
            const p = path.join(dir, program + ext);
            if (fileExists(p)) return p;
        }
    }
    return null;
}

export interface ResolvedCommand {
    program: string;
    args: string[];
    shell: boolean;
}

/** 解析 ACP 启动命令；留空时回退 "dsh --profile acp"。 */
export function resolveAcpCommand(command?: string): ResolvedCommand {
    const cmd = (command && command.trim()) || 'dsh --profile acp';
    const { program, args } = splitCommand(cmd);
    const resolved = resolveExecutable(program);
    const finalProgram = resolved ?? program;
    const ext = path.extname(finalProgram).toLowerCase();
    // Windows npm shim（.cmd/.bat）：提取真实 JS 入口，用 node 直接启动（绕开 cmd.exe）
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
        const entry = resolveShimTarget(finalProgram);
        if (entry) {
            const node = resolveExecutable('node') || 'node';
            return { program: node, args: [entry, ...args], shell: false };
        }
    }
    // .ps1 不能交给 cmd.exe，须用 powershell.exe -File 启动（shell:false）
    if (process.platform === 'win32' && ext === '.ps1') {
        return {
            program: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', finalProgram, ...args],
            shell: false,
        };
    }
    const shell = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
    return { program: finalProgram, args, shell };
}

/** 是否仅以命令名（未解析到真实文件，需交给系统在 PATH 中查找）。 */
export function isBareCommand(program: string): boolean {
    return !path.isAbsolute(program) && !fileExists(program);
}

/**
 * 解析 npm 生成的 .cmd/.bat shim，提取其真实 Node 入口（如 ...\node_modules\@deepseek-ai\dsh\lib\bin.js）。
 * 这样可以用 `node <entry>` 直接启动，完全绕开 cmd.exe / shell。
 */
export function resolveShimTarget(shimPath: string): string | null {
    try {
        const content = fs.readFileSync(shimPath, 'utf-8');
        const m = content.match(/node_modules[\\/]([^"%\r\n]+?\.js)/);
        if (!m) return null;
        const target = path.join(path.dirname(shimPath), 'node_modules', m[1]);
        return fileExists(target) ? target : null;
    } catch {
        return null;
    }
}

// ==================== 断链自愈（Phase 2.1） ====================

/** 断链自愈最大自动重启次数（之后给出明确错误，交由用户手动处理）。 */
export const MAX_RESTART_ATTEMPTS = 3;

/** 第 attempt 次自动重启前的等待毫秒数（指数退避 1s → 2s → 4s，封顶 maxMs）。 */
export function restartDelayMs(attempt: number, baseMs = 1000, maxMs = 4000): number {
    if (!Number.isFinite(attempt) || attempt < 0) return 0;
    return Math.min(baseMs * Math.pow(2, attempt), maxMs);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== DeepSeek 适配器 ====================

export class DeepSeekBridgeAdapter implements BridgeAdapter {
    readonly name = 'DeepSeek Harness (ACP)';
    readonly capabilities: BridgeCapabilities = {
        streaming: true,
        // ACP 官方实现只流式交付已提交文本；思考过程取决于具体 ACP 服务器（dsh-acp-enhanced 等会暴露）
        thinking: true,
        toolUse: true,
        sessionManagement: true,
        workspaceAccess: true,
    };

    private client: AcpClient | null = null;
    private config: BridgeConfig = {};
    private permissionHandler: ((request: PermissionRequest) => Promise<PermissionResponse>) | null = null;
    private initializeError: string | null = null;
    private sessionCwd: string | undefined = undefined;
    /** ACP 进程是否曾意外退出（区别于显式 re-init / dispose）。 */
    private stale = false;
    /** 连接代际：每次成功 initialize 自增；上层据此判断旧 sessionId 是否已在新进程上失效。 */
    private epoch = 0;
    /** 断链自愈：连续自动重启次数（成功即清零）。 */
    private restartAttempts = 0;
    /** 单飞锁：并发发送撞上同一次重启时共享同一 Promise，避免重复 spawn。 */
    private restartPromise: Promise<void> | null = null;
    /** 仅测试：注入内存传输，跳过真实 spawn。 */
    private injectedTransport: AcpTransport | undefined;
    /** 退避基数（毫秒）；仅测试可传 0 跳过等待。 */
    private restartBaseMs = 1000;

    constructor(options?: { transport?: AcpTransport; restartDelayBaseMs?: number }) {
        this.injectedTransport = options?.transport;
        if (options?.restartDelayBaseMs !== undefined) {
            this.restartBaseMs = options.restartDelayBaseMs;
        }
    }

    /** 当前连接代际（每次成功重启自增；0 表示从未成功连接过）。 */
    getEpoch(): number {
        return this.epoch;
    }

    /** ACP 客户端当前是否可运行。 */
    isConnected(): boolean {
        return !!this.client && this.client.isRunning;
    }

    async initialize(config: BridgeConfig): Promise<void> {
        // 重新初始化前先 dispose 旧进程，避免设置变更后残留孤儿进程（S7）。
        if (this.client) {
            const old = this.client;
            this.client = null;
            try { await old.close(); } catch { /* ignore */ }
        }
        this.config = config;
        this.sessionCwd = config.vaultPath || process.cwd();
        this.initializeError = null;

        const { program, args, shell } = resolveAcpCommand(config.command);
        // 插件内配置 → ACP 进程环境变量：key → DEEPSEEK_API_KEY，地址 → DEEPSEEK_BASE_URL
        // （官方 dsh-llm-deepseek 原生支持；baseURL 解析顺序 config > DEEPSEEK_BASE_URL > 默认 api.deepseek.com）
        const env: NodeJS.ProcessEnv = {};
        if (config.apiKey) env.DEEPSEEK_API_KEY = config.apiKey;
        if (config.baseUrl) env.DEEPSEEK_BASE_URL = config.baseUrl;
        const clientOptions: AcpClientOptions = {
            program,
            args,
            cwd: this.sessionCwd,
            shell,
            requestTimeoutMs: config.timeoutMs ?? 15000,
            env: Object.keys(env).length > 0 ? env : undefined,
            transport: this.injectedTransport, // 仅测试注入；生产缺省走真实 spawn
            onPermission: async (req) => {
                if (!this.permissionHandler) return { outcome: 'cancelled' };
                return this.permissionHandler({
                    sessionId: req.sessionId,
                    toolCall: { toolCallId: req.toolCallId },
                    options: req.options.map(o => ({
                        optionId: o.optionId,
                        name: o.name,
                        kind: o.kind === 'allow_always' ? 'allow_always'
                            : o.kind === 'reject_once' ? 'reject_once'
                            : o.kind === 'reject_always' ? 'reject_always'
                            : 'allow_once',
                    })),
                });
            },
            onLog: (msg) => console.log('[BD]', msg),
        };
        const client = new AcpClient(clientOptions);
        // 断链自愈（2.1）：进程意外退出 → 标 stale + 置空引用；下次发送时自动重启
        client.onExit(() => {
            this.stale = true;
            this.client = null;
        });

        try {
            await client.start();
            await client.initialize();
        } catch (e) {
            this.initializeError = getErrorMessage(e);
            try { await client.close(); } catch { /* ignore */ }
            throw new Error(this.initializeError);
        }
        this.client = client;
        this.stale = false; // 新进程就绪（onExit 在显式 re-init 关闭旧进程时也会触发，成功后再清）
        this.restartAttempts = 0; // 重启成功，退避计数清零
        this.epoch += 1; // 新进程：旧 session 全部失效
    }

    setPermissionHandler(handler: (request: PermissionRequest) => Promise<PermissionResponse>): void {
        this.permissionHandler = handler;
    }

    async dispose(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) {
            try { await client.close(); } catch { /* ignore */ }
        }
    }

    /**
     * 确保 ACP 客户端可运行（断链自愈 2.1）。
     * 进程已退出（stale）或从未连接：自动重启，指数退避 1s→2s→4s，
     * 超过 MAX_RESTART_ATTEMPTS 次后放弃并抛出明确错误。
     * 单飞锁：多个并发发送共享同一次重启，避免重复 spawn 竞态。
     */
    private async ensureRunning(): Promise<AcpClient> {
        if (this.client && this.client.isRunning) return this.client;
        if (!this.restartPromise) {
            this.restartPromise = this.doRestart().finally(() => {
                this.restartPromise = null;
            });
        }
        await this.restartPromise;
        if (!this.client || !this.client.isRunning) {
            throw new Error('ACP 连接未就绪。请在设置页点击「诊断」检查 DSH 配置。');
        }
        return this.client;
    }

    /** 执行一次自动重启（含退避等待）。失败不吞错：restartAttempts 累计，下次发送继续退避。 */
    private async doRestart(): Promise<void> {
        const attempt = this.restartAttempts;
        if (attempt >= MAX_RESTART_ATTEMPTS) {
            this.initializeError =
                `DSH 进程反复退出（已自动重启 ${attempt} 次仍失败），已停止自动重启。请检查 ACP 配置后点击「诊断」或直接重试`;
            throw new Error(this.initializeError);
        }
        const delayMs = restartDelayMs(attempt, this.restartBaseMs);
        this.restartAttempts = attempt + 1;
        console.warn(`[BD] DSH 进程已退出，${delayMs}ms 后自动重启（第 ${attempt + 1}/${MAX_RESTART_ATTEMPTS} 次）`);
        await sleep(delayMs);
        await this.initialize(this.config);
    }

    async createSession(_cwd?: string): Promise<string> {
        const client = await this.ensureRunning();
        return client.newSession(_cwd || this.sessionCwd);
    }

    async *sendMessage(sessionId: string, message: UserMessage, _context: VaultContext): AsyncGenerator<StreamChunk> {
        const client = await this.ensureRunning();
        // 透传原文：上下文注入（当前笔记等）已由 chat view 在组装 prompt 时完成，
        // 适配层不再二次包装，避免重复/竞态（原 buildPrompt 死代码已删，见 2.3）。
        const promptText = message.content;
        const { result, stream } = client.prompt(sessionId, promptText);

        const timeoutMs = this.config.timeoutMs ?? 300_000;
        let timedOut = false;
        let cancelPromise: Promise<void> | null = null;
        const timer = setTimeout(() => {
            if (timedOut) return;
            timedOut = true;
            cancelPromise = client.cancel(sessionId).catch(() => { /* ignore */ });
            stream.end();
        }, timeoutMs);
        timer.unref?.();

        try {
            for await (const chunk of stream) {
                if (timedOut) break;
                // 流中的 done（session_ended 等）只是中转信号；由最终 settlement 产出唯一 done（#4）
                if (chunk.type === 'done') continue;
                yield chunk;
            }
            if (timedOut) {
                // 先挂 rejection 兜底：等取消落定期间原 prompt 可能已结算/reject，防 unhandled rejection（#3）
                result.catch(() => { /* ignored */ });
                // 等取消彻底落定再返回：队列泵会立刻复用同 session 发下一条，
                // 不等待会让下一条 prompt 撞上同会话 in-flight 竞态（#high-race）
                if (cancelPromise) await cancelPromise;
                yield {
                    type: 'error',
                    content: `请求超时（已等待 ${Math.round(timeoutMs / 1000)} 秒），请检查 DSH ACP 服务是否正常运行或尝试重试`,
                };
                return;
            }
            const res = await result;
            yield { type: 'done', usage: res.usage };
        } catch (e) {
            if (!timedOut) result.catch(() => { /* ignored */ });
            yield { type: 'error', content: getErrorMessage(e) };
        } finally {
            clearTimeout(timer);
        }
    }

    cancel(sessionId?: string): Promise<void> {
        const client = this.client;
        if (!client) return Promise.resolve();
        if (sessionId) {
            return client.cancel(sessionId);
        }
        return client.cancelAll();
    }

    async diagnose(): Promise<DiagnosticResult> {
        const checks: DiagnosticCheck[] = [];
        const { program, args } = resolveAcpCommand(this.config.command);
        const resolved = resolveExecutable(program);

        checks.push({
            name: 'ACP 启动命令',
            passed: !!program,
            message: program ? `${program} ${args.join(' ')}` : '未配置',
            fix: !program ? '请在设置中填写 DSH ACP 命令（如 dsh --profile acp）' : undefined,
        });
        checks.push({
            name: 'DSH 可执行文件',
            passed: !!resolved || isBareCommand(program),
            message: resolved || program,
            fix: (!resolved && !isBareCommand(program))
                ? '找不到该命令，请确认已安装 DeepSeek Harness 或指定正确路径'
                : undefined,
        });
        checks.push({
            name: 'Vault 工作目录',
            passed: !!this.sessionCwd,
            message: this.sessionCwd,
        });
        const running = this.isConnected();
        checks.push({
            name: 'ACP 进程',
            passed: running,
            message: running ? '已连接' : (this.stale ? '已断开（进程意外退出，发送时将自动重启）' : (this.initializeError ?? '未启动')),
            fix: running ? undefined
                : this.stale
                    ? '进程已退出：直接发送一条消息将自动重启；若反复失败请检查 ACP profile 配置'
                    : '请确认 ACP profile 已配置（dsh plugin --profile acp add ...）并重试',
        });

        const failed = checks.filter(c => !c.passed);
        return {
            status: failed.length === 0 ? 'ok' : 'error',
            checks,
        };
    }
}

// ==================== Vault 工具上下文（绑定 Obsidian Vault API） ====================
// 为 read_note / write_note / search_vault 提供真实实现（Bao 版虚拟 MCP 与插件自身工具共用）。
// 本文件仅导出类型化的构造函数；Obsidian App 依赖在 src/main.ts 注入。

import type { VaultToolContext } from '../../core/vault-tools';

export interface ObsidianVaultLike {
    read(path: string): Promise<string>;
    modify(path: string, content: string): Promise<void>;
    create(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    getFiles(): Array<{ path: string; basename: string; extension: string }>;
    adapter: { basePath?: string };
}

/** 从 Obsidian Vault 构造 VaultToolContext。 */
export function createVaultToolContext(vault: ObsidianVaultLike): VaultToolContext {
    return {
        readNote: async (p: string) => {
            try {
                if (!(await vault.exists(p))) return null;
                return await vault.read(p);
            } catch {
                return null;
            }
        },
        writeNote: async (p: string, content: string) => {
            try {
                if (await vault.exists(p)) {
                    await vault.modify(p, content);
                } else {
                    await vault.create(p, content);
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: getErrorMessage(e) };
            }
        },
        searchVault: async (query: string, limit: number) => {
            const q = query.toLowerCase();
            const hits: Array<{ path: string; snippet?: string }> = [];
            for (const file of vault.getFiles()) {
                if (hits.length >= limit) break;
                if (file.path.toLowerCase().includes(q) || file.basename.toLowerCase().includes(q)) {
                    hits.push({ path: file.path });
                }
            }
            return hits;
        },
    };
}


