// ==================== ACP JSON-RPC stdio 客户端 ====================
// 依据 @deepseek-ai/dsh-acp（官方 ACP 自动化服务器）的真实 wire 格式实现：
//   - 请求：initialize / session/new / session/prompt / session/cancel
//   - 通知：session/update（agent_message_chunk / agent_thought_chunk / tool_call ...）
//   - 服务端请求：session/request_permission（客户端需回 outcome）
// 同时做了防御性解析，兼容方案文档里的简化字段（event.type / event.chunk.text）。

import { spawn, type ChildProcess } from 'child_process';
import { isObject, getString, getErrorMessage } from '../../types';
import type { StreamChunk, StreamUsage } from '../../core/stream-chunk';

// ==================== 纯解析函数（可单测） ====================

/** 从单个 ACP ContentBlock 提取纯文本；非文本块返回 null。 */
export function contentBlockToText(block: unknown): string | null {
    if (!isObject(block)) return null;
    if (block.type === 'text') {
        const text = getString(block, 'text');
        return text ?? '';
    }
    if (block.type === 'resource_link') {
        const name = getString(block, 'name');
        const uri = getString(block, 'uri');
        return uri ? `[resource_link name=${JSON.stringify(name ?? '')} uri=${JSON.stringify(uri)}]` : null;
    }
    return null;
}

/**
 * 将 session/update 的 content 字段（单个 ContentBlock 或 ContentBlock 数组）
 * 规整为文本字符串。
 */
export function contentToText(content: unknown): string {
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            const text = contentBlockToText(block);
            if (text !== null) parts.push(text);
        }
        return parts.join('');
    }
    return contentBlockToText(content) ?? '';
}

/** 判断一个文本块是否被忽略（用户消息回显等不展示内容）。 */
function isIgnoredUpdate(updateType: string): boolean {
    return /user_message/i.test(updateType);
}

/**
 * 从 session/update 中提取文本：
 * 依次尝试 update.content（真实格式）→ update.chunk.text（简化格式）→ update.text。
 */
function extractTextFromUpdate(update: Record<string, unknown>): string {
    const direct = contentToText(update.content);
    if (direct) return direct;
    if (isObject(update.chunk)) {
        const chunkText = getString(update.chunk, 'text');
        if (chunkText) return chunkText;
    }
    return getString(update, 'text') ?? '';
}

/**
 * 解析 ACP session/update 通知参数 → StreamChunk。
 * 支持两种形态：
 *   A) 真实 @deepseek-ai/dsh-acp：{ sessionId, update: { sessionUpdate, content, ... } }
 *   B) 简化形态（方案文档）：{ sessionId, type, chunk: { text }, tool: { name, arguments, id } }
 */
export function parseAcpUpdate(params: unknown): StreamChunk | null {
    if (!isObject(params)) return null;
    const update = isObject(params.update) ? params.update : params;
    const updateType = getString(update, 'sessionUpdate') ?? getString(update, 'type') ?? '';
    if (!updateType) return null;
    if (isIgnoredUpdate(updateType)) return null;

    const lower = updateType.toLowerCase();

    // 思考过程
    if (lower.includes('thought')) {
        const text = extractTextFromUpdate(update);
        return { type: 'thinking', content: text };
    }

    // 工具调用
    if (lower.includes('tool_call')) {
        const tool = isObject(update.tool) ? update.tool : {};
        const toolName = getString(tool, 'name')
            ?? getString(update, 'name')
            ?? getString(update, 'title')
            ?? 'unknown';
        const rawArgs = tool.arguments ?? update.rawInput ?? update.input;
        const toolDetail = typeof rawArgs === 'string'
            ? rawArgs
            : JSON.stringify(rawArgs ?? {});
        const toolCallId = getString(tool, 'id')
            ?? getString(update, 'toolCallId')
            ?? getString(update, 'callId')
            ?? '';
        return { type: 'tool', toolName, toolDetail, toolCallId };
    }

    // 助手消息文本
    if (lower.includes('agent_message') || lower === 'text') {
        const text = extractTextFromUpdate(update);
        return { type: 'text', content: text };
    }

    // 结束 / 取消
    if (lower.includes('done') || lower.includes('session_ended') || lower === 'end' || lower === 'cancelled') {
        return { type: 'done' };
    }

    // 错误
    if (lower.includes('error')) {
        const content = extractTextFromUpdate(update)
            || getString(update, 'message')
            || getString(update, 'error')
            || '未知错误';
        return { type: 'error', content };
    }

    return null;
}

/** 解析 session/prompt 响应结果。 */
export function parsePromptResult(raw: unknown): { stopReason: string; usage?: StreamUsage } {
    const stopReason = isObject(raw) && typeof getString(raw, 'stopReason') === 'string'
        ? getString(raw, 'stopReason')!
        : 'end_turn';
    let usage: StreamUsage | undefined;
    if (isObject(raw) && isObject(raw.usage)) {
        const u = raw.usage as Record<string, unknown>;
        const num = (k: string) => typeof u[k] === 'number' ? u[k] as number : undefined;
        usage = {
            inputTokens: num('inputTokens'),
            outputTokens: num('outputTokens'),
            totalTokens: num('totalTokens'),
            thoughtTokens: num('thoughtTokens'),
            cachedReadTokens: num('cachedReadTokens'),
            cachedWriteTokens: num('cachedWriteTokens'),
        };
    }
    return { stopReason, usage };
}

/** 提取 JSON-RPC error 对象的人类可读信息。 */
export function extractRpcError(error: unknown): string {
    if (isObject(error)) {
        const msg = getString(error, 'message');
        const detail = getString(error, 'data');
        if (msg && detail) return `${msg}: ${detail}`;
        if (msg) return msg;
    }
    return '未知 RPC 错误';
}

// ==================== 会话事件流 ====================

/** 按会话聚合的 StreamChunk 异步队列（供 sendMessage 迭代）。 */
export class SessionStream implements AsyncIterable<StreamChunk> {
    private queue: StreamChunk[] = [];
    private waiters: Array<(r: IteratorResult<StreamChunk>) => void> = [];
    private ended = false;

    push(chunk: StreamChunk): void {
        if (this.ended) return;
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({ value: chunk, done: false });
        } else {
            this.queue.push(chunk);
        }
    }

    end(): void {
        if (this.ended) return;
        this.ended = true;
        for (const waiter of this.waiters) {
            waiter({ value: undefined, done: true });
        }
        this.waiters = [];
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
        while (true) {
            const next = this.queue.shift();
            if (next) {
                yield next;
                continue;
            }
            if (this.ended) return;
            const result = await new Promise<IteratorResult<StreamChunk>>((resolve) => {
                this.waiters.push(resolve);
            });
            if (result.done) return;
            yield result.value;
        }
    }
}

// ==================== ACP 权限请求 ====================

export interface AcpPermissionOption {
    optionId: string;
    name: string;
    kind: string;
}

export interface AcpPermissionRequest {
    sessionId: string;
    toolCallId: string;
    options: AcpPermissionOption[];
}

export type AcpPermissionResponse = { outcome: 'selected' | 'cancelled'; optionId?: string };
export type AcpPermissionHandler = (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;

// ==================== 传输层（可注入，便于端到端测试） ====================

/**
 * 与对端（真实 ACP 进程或内存 mock）交换「一行 JSON」的传输抽象。
 * 生产环境使用基于 child_process 的 spawn 传输；测试可用 createMemoryTransportPair。
 */
export interface AcpTransport {
    /** 向对端写一行（调用方负责 JSON.stringify + 换行）。 */
    write(line: string): void;
    /** 注册「对端发来一行」回调。 */
    onLine(cb: (line: string) => void): void;
    /** 注册「连接关闭」回调。 */
    onClose(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    isOpen(): boolean;
    close(): void;
    /** 仅测试用：模拟对端关闭。 */
    simulateClose?(code?: number | null): void;
    /** 仅测试用：配合断链自愈——模拟对端重新可用（重启后的新客户端可继续通信）。 */
    reopen?(): void;
}

/** 创建一对背靠背的内存传输（客户端端 + 服务器端），用于在进程内模拟 ACP 服务器。 */
export function createMemoryTransportPair(): { client: AcpTransport; server: AcpTransport } {
    const clientCbs: Array<(line: string) => void> = [];
    const serverCbs: Array<(line: string) => void> = [];
    const clientCloseCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const serverCloseCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    let clientOpen = true;
    let serverOpen = true;

    const makeTransport = (
        incoming: Array<(line: string) => void>,
        outgoing: Array<(line: string) => void>,
        closeCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void>,
        isOpenRef: () => boolean,
        setOpen: (v: boolean) => void,
    ): AcpTransport => ({
        write(line) {
            if (!isOpenRef()) return;
            for (const cb of incoming) {
                try { cb(line); } catch { /* ignore */ }
            }
        },
        onLine(cb) { outgoing.push(cb); },
        onClose(cb) { closeCbs.push(cb); },
        isOpen: isOpenRef,
        close() { setOpen(false); },
        simulateClose(code = null) {
            setOpen(false);
            for (const cb of closeCbs) {
                try { cb(code, null); } catch { /* ignore */ }
            }
        },
        reopen() { setOpen(true); },
    });

    return {
        client: makeTransport(serverCbs, clientCbs, clientCloseCbs, () => clientOpen, (v) => { clientOpen = v; }),
        server: makeTransport(clientCbs, serverCbs, serverCloseCbs, () => serverOpen, (v) => { serverOpen = v; }),
    };
}

// ==================== ACP 客户端 ====================

export interface AcpClientOptions {
    program: string;
    args: string[];
    cwd?: string;
    shell?: boolean;
    /** 注入的内存传输（测试用）；缺省时按 program/args spawn。 */
    transport?: AcpTransport;
    /** 普通 RPC（initialize/session/new/cancel）超时，默认 15s。prompt 不在此列（由适配层超时）。 */
    requestTimeoutMs?: number;
    /** 追加到进程环境变量的键值（如 DEEPSEEK_API_KEY）；与 process.env 合并，冲突时此项优先。 */
    env?: NodeJS.ProcessEnv;
    onPermission?: AcpPermissionHandler;
    onLog?: (message: string) => void;
}

export interface AcpPromptResult {
    stopReason: string;
    usage?: StreamUsage;
}

interface PendingRequest {
    method: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
}

export class AcpClient {
    private proc: ChildProcess | null = null;
    private transport: AcpTransport | null = null;
    private requestId = 0;
    private pending = new Map<number, PendingRequest>();
    private sessionStreams = new Map<string, SessionStream>();
    private inflightSessions = new Set<string>();
    private closed = false;
    private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    private options: AcpClientOptions;

    constructor(options: AcpClientOptions) {
        this.options = options;
    }

    get isRunning(): boolean {
        return this.transport ? this.transport.isOpen() : !!this.proc && this.proc.exitCode === null;
    }

    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
        this.exitListeners.push(listener);
    }

    /** 启动：优先使用注入的传输（测试），否则 spawn 子进程。spawn 失败（如 ENOENT）时 reject。 */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.transport || this.proc) {
                resolve();
                return;
            }
            const injected = this.options.transport;
            if (injected) {
                this.transport = injected;
                injected.onLine((line) => this.handleLine(line));
                injected.onClose((code, signal) => this.onProcessClose(code, signal));
                resolve();
                return;
            }

            let settled = false;
            const { program, args, cwd, shell } = this.options;
            let proc: ChildProcess;
            try {
                proc = spawn(program, args, {
                    cwd,
                    shell: !!shell,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    // 只追加不覆盖：保证系统环境变量（PATH 等）照常继承
                    env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
                });
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            this.proc = proc;
            this.transport = createSpawnTransport(proc, (line) => this.handleLine(line));

            proc.stderr?.on('data', (d: Buffer) => this.onStderrData(d));
            proc.on('error', (e: Error) => {
                this.options.onLog?.(`[dsh spawn error] ${e.message}`);
                if (!settled) {
                    settled = true;
                    reject(e);
                }
            });
            proc.on('close', (code, signal) => this.onProcessClose(code, signal));

            // 下一 tick 未触发 error 视为进程已拉起
            setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            }, 0);
        });
    }

    async close(): Promise<void> {
        const transport = this.transport;
        if (!transport) return;
        transport.close();
        const proc = this.proc;
        if (proc) {
            // 尝试优雅结束：写入 EOF 让 ACP 服务器 flush 后退出
            try {
                if (!proc.stdin.destroyed) {
                    proc.stdin.end();
                }
            } catch { /* ignore */ }
            await new Promise<void>((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { proc.kill(); } catch { /* ignore */ }
                    resolve();
                }, 2000);
                timer.unref?.();
                if (proc.exitCode !== null) {
                    clearTimeout(timer);
                    settled = true;
                    resolve();
                    return;
                }
                proc.once('close', () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.onProcessClose(proc.exitCode, proc.signalCode);
        }
    }

    // ==================== RPC ====================

    private nextId(): number {
        return ++this.requestId;
    }

    private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (this.closed || !this.transport) {
                reject(new Error('ACP 进程未运行'));
                return;
            }
            const id = this.nextId();
            const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? 15000;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP 请求超时: ${method}`));
            }, effectiveTimeout);
            timer.unref?.();
            this.pending.set(id, {
                method,
                resolve,
                reject,
                timer,
            });
            this.write({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
        });
    }

    /** initialize：协商协议版本。 */
    initialize(): Promise<unknown> {
        return this.request('initialize', {
            // 官方 @agentclientprotocol/sdk zInitializeRequest 必填（int 0-65535）：
            // 缺失会被服务端以 -32602 Invalid params 拒绝（dsh-acp-demo 0.1.1-rc.2 实测）。
            protocolVersion: 1,
            capabilities: {
                workspace: {},
                additionalDirectories: [],
                mcpServers: [],
                sessionManagement: {},
                terminal: {},
                promptCapabilities: { text: true },
                toolSupport: {},
            },
        });
    }

    /** session/new：创建新会话（cwd 必须是绝对路径）。 */
    async newSession(cwd?: string): Promise<string> {
        const result = await this.request('session/new', {
            cwd: cwd || process.cwd(),
            additionalDirectories: [],
            mcpServers: [],
        });
        const sessionId = isObject(result) ? getString(result, 'sessionId') : undefined;
        if (!sessionId) throw new Error('session/new 未返回 sessionId');
        return sessionId;
    }

    /** session/prompt：发送提示并流式接收助手消息。每会话同一时刻仅允许一个 in-flight。 */
    prompt(sessionId: string, text: string): { result: Promise<AcpPromptResult>; stream: SessionStream } {
        const stream = this.getSessionStream(sessionId);
        // 进程未运行或已关闭：立即结束流并拒绝，避免挂起（#2）。
        if (this.closed || !this.transport) {
            stream.end();
            return { result: Promise.reject(new Error('ACP 进程未运行')), stream };
        }
        // 每会话单 in-flight：防止两个 prompt 共享同一 SessionStream 造成串扰（#5）。
        if (this.inflightSessions.has(sessionId)) {
            stream.end();
            return { result: Promise.reject(new Error('该会话已有进行中的请求')), stream };
        }
        this.inflightSessions.add(sessionId);
        const id = this.nextId();
        const finish = () => {
            // 仅当本 prompt 仍是该会话当前流时，才清理 in-flight 标记与流句柄：
            // 若同会话已发起后续 prompt（map 指向新流），in-flight 归属新 prompt，
            // 由它的 finish 负责清理——迟来的 finish 不得误删（竞态修复 + 纵深防御）。
            if (this.sessionStreams.get(sessionId) === stream) {
                this.inflightSessions.delete(sessionId);
                this.sessionStreams.delete(sessionId);
            }
        };
        const result = new Promise<AcpPromptResult>((resolve, reject) => {
            this.pending.set(id, {
                method: 'session/prompt',
                resolve: (value) => {
                    stream.end();
                    finish();
                    resolve(parsePromptResult(value));
                },
                reject: (err) => {
                    stream.end();
                    finish();
                    reject(err);
                },
                timer: null,
            });
        });
        this.write({
            jsonrpc: '2.0',
            id,
            method: 'session/prompt',
            params: {
                sessionId,
                prompt: [{ type: 'text', text }],
            },
        });
        return { result, stream };
    }

    /** session/cancel：取消指定会话的进行中请求。返回的 Promise 在取消彻底落定后 resolve。 */
    async cancel(sessionId: string): Promise<void> {
        if (this.closed || !this.transport) return;
        // 捕获发起取消时的流，只结束它：避免误伤同会话后续 prompt 新建的流（竞态修复）。
        const stream = this.sessionStreams.get(sessionId);
        try {
            await this.request('session/cancel', { sessionId });
        } catch (e) {
            this.options.onLog?.(`[dsh cancel failed] ${getErrorMessage(e)}`);
        } finally {
            if (stream) {
                stream.end();
                // 仅当 map 里还是我们捕获的流时才删除；已有新流（后续 prompt）则保留
                if (this.sessionStreams.get(sessionId) === stream) {
                    this.sessionStreams.delete(sessionId);
                }
            }
            this.inflightSessions.delete(sessionId);
        }
    }

    /** 取消所有进行中的会话。 */
    async cancelAll(): Promise<void> {
        const targets = [...this.inflightSessions];
        for (const sid of targets) {
            await this.cancel(sid);
        }
        for (const stream of this.sessionStreams.values()) {
            stream.end();
        }
        this.sessionStreams.clear();
    }

    private getSessionStream(sessionId: string): SessionStream {
        let stream = this.sessionStreams.get(sessionId);
        if (!stream) {
            stream = new SessionStream();
            this.sessionStreams.set(sessionId, stream);
        }
        return stream;
    }

    // ==================== 接收 ====================

    /** 处理对端发来的一行（由 transport 喂入；负责缓冲拼接与 JSON 解析）。 */
    private handleLine(rawLine: string): void {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        if (!trimmed.startsWith('{')) {
            this.options.onLog?.(`[dsh stdout] ${trimmed.substring(0, 200)}`);
            return;
        }
        try {
            this.handleMessage(JSON.parse(trimmed));
        } catch (e) {
            this.options.onLog?.(`[dsh parse error] ${getErrorMessage(e)}`);
        }
    }

    private onStderrData(data: Buffer): void {
        const text = data.toString().trim();
        if (text) this.options.onLog?.(`[dsh stderr] ${text.substring(0, 400)}`);
    }

    private handleMessage(raw: unknown): void {
        if (!isObject(raw)) return;
        const id = raw.id;
        const method = getString(raw, 'method');

        // 响应：JSON-RPC 响应不带 method 字段。务必先按 method 判别，
        // 否则服务器发来的 session/request_permission 请求（带 method + id）
        // 若其 id 与客户端挂起请求 id 相同，会被误判为响应并吞掉（阻塞 #1）。
        if (typeof id === 'number' && !method && this.pending.has(id)) {
            const pending = this.pending.get(id)!;
            this.pending.delete(id);
            if (pending.timer) clearTimeout(pending.timer);
            if (raw.error !== undefined && raw.error !== null) {
                pending.reject(new Error(extractRpcError(raw.error)));
            } else {
                pending.resolve(raw.result);
            }
            return;
        }

        if (!method) return;
        const params = raw.params;

        if (method === 'session/update') {
            const sessionId = isObject(params) ? getString(params, 'sessionId') : undefined;
            const chunk = parseAcpUpdate(params);
            if (sessionId && chunk) {
                this.getSessionStream(sessionId).push(chunk);
            }
        } else if (method === 'session/request_permission') {
            // 服务端发来的请求，需要回 outcome
            void this.handlePermissionRequest(id, params);
        }
    }

    private async handlePermissionRequest(id: unknown, params: unknown): Promise<void> {
        const respond = (result: unknown) => {
            if (typeof id === 'number') {
                this.write({ jsonrpc: '2.0', id, result });
            }
        };
        const cancel = () => respond({ outcome: { outcome: 'cancelled' } });
        try {
            const rawParams = isObject(params) ? params : {};
            const sessionId = getString(rawParams, 'sessionId') ?? '';
            const toolCall = isObject(rawParams.toolCall) ? rawParams.toolCall : {};
            const toolCallId = getString(toolCall, 'toolCallId') ?? '';
            const options: AcpPermissionOption[] = Array.isArray(rawParams.options)
                ? rawParams.options
                    .filter((o: unknown) => isObject(o) && typeof getString(o, 'optionId') === 'string')
                    .map((o: Record<string, unknown>) => ({
                        optionId: getString(o, 'optionId')!,
                        name: getString(o, 'name') ?? '',
                        kind: getString(o, 'kind') ?? '',
                    }))
                : [];
            if (!this.options.onPermission) {
                cancel();
                return;
            }
            const response = await this.options.onPermission({ sessionId, toolCallId, options });
            // selected 但缺 optionId（协议要求必须有）→ 视为取消，避免回填空字符串（#13）
            if (response.outcome === 'cancelled' || !response.optionId) {
                cancel();
            } else {
                respond({ outcome: { outcome: 'selected', optionId: response.optionId } });
            }
        } catch {
            cancel();
        }
    }

    private onProcessClose(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.closed && !this.proc && !this.transport) return;
        this.closed = true;
        const detail = `DSH 进程已退出${code !== null ? `（退出码 ${code}）` : signal ? `（信号 ${signal}）` : ''}`;
        for (const [, pending] of this.pending) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error(detail));
        }
        this.pending.clear();
        for (const stream of this.sessionStreams.values()) {
            stream.end();
        }
        this.sessionStreams.clear();
        this.inflightSessions.clear();
        this.proc = null;
        this.transport = null;
        for (const listener of this.exitListeners) {
            try {
                listener(code, signal);
            } catch { /* ignore listener errors */ }
        }
        this.exitListeners = [];
    }

    private write(msg: unknown): void {
        if (!this.transport) return;
        try {
            this.transport.write(JSON.stringify(msg) + '\n');
        } catch (e) {
            this.options.onLog?.(`[dsh write error] ${getErrorMessage(e)}`);
        }
    }
}

/** 基于 child_process 的 spawn 传输：行缓冲并回调 handleLine。 */
function createSpawnTransport(proc: ChildProcess, onLine: (line: string) => void): AcpTransport {
    let buffer = '';
    proc.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            onLine(line);
        }
    });
    return {
        write(line) {
            if (proc.stdin.destroyed) return;
            proc.stdin.write(line);
        },
        onLine(_cb: (line: string) => void) { /* spawn 传输的行由上面 stdout 事件驱动，无需注册 */ },
        onClose(_cb: (code: number | null, signal: NodeJS.Signals | null) => void) { /* 由 proc.on('close') 驱动 */ },
        isOpen() {
            return proc.exitCode === null;
        },
        close() {
            try {
                if (!proc.stdin.destroyed) proc.stdin.end();
            } catch { /* ignore */ }
        },
    };
}
