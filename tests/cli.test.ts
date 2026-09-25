import {
    DeepSeekBridgeAdapter,
    MAX_RESTART_ATTEMPTS,
    restartDelayMs,
    resolveAcpCommand,
    resolveExecutable,
    resolveShimTarget,
    isBareCommand,
    createVaultToolContext,
} from '../src/bridges/deep/cli';
import type { PermissionOptionKind } from '../src/core/bridge-adapter';
import { createMemoryTransportPair } from '../src/bridges/deep/acp-client';
import { MockAcpServer, initHandler, type WireMessage } from './helpers/mock-acp-server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ==================== restartDelayMs ====================

describe('restartDelayMs（指数退避 1s → 2s → 4s）', () => {
    it('按 2 的幂增长并封顶 4s', () => {
        expect(restartDelayMs(0)).toBe(1000);
        expect(restartDelayMs(1)).toBe(2000);
        expect(restartDelayMs(2)).toBe(4000);
        expect(restartDelayMs(3)).toBe(4000);
        expect(restartDelayMs(10)).toBe(4000);
    });

    it('非法 attempt 返回 0（不等待）', () => {
        expect(restartDelayMs(-1)).toBe(0);
        expect(restartDelayMs(NaN)).toBe(0);
    });

    it('支持自定义基数（测试加速用）', () => {
        expect(restartDelayMs(0, 5)).toBe(5);
        expect(restartDelayMs(1, 5)).toBe(10);
        expect(restartDelayMs(2, 5)).toBe(20);
    });
});

// ==================== DeepSeekBridgeAdapter 断链自愈（2.1） ====================

describe('DeepSeekBridgeAdapter 断链自愈', () => {
    it('未连接时 isConnected=false、getEpoch=0', () => {
        const adapter = new DeepSeekBridgeAdapter();
        expect(adapter.isConnected()).toBe(false);
        expect(adapter.getEpoch()).toBe(0);
    });

    it('进程意外退出 → isConnected=false、代际不变（重启惰性，不在退出时立即触发）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 'sid-1' });
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        expect(adapter.isConnected()).toBe(true);
        const epoch = adapter.getEpoch();

        pair.client.simulateClose?.(1);
        expect(adapter.isConnected()).toBe(false);
        expect(adapter.getEpoch()).toBe(epoch); // 未做任何重启，代际未变
    });

    it('发送时自动重启：createSession 触发 → 新进程新 session、代际 +1', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let sessionSeq = 0;
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') {
                sessionSeq += 1;
                server.respond(msg.id!, { sessionId: `sid-${sessionSeq}` });
            }
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        expect(await adapter.createSession('C:\\vault')).toBe('sid-1');
        const epoch1 = adapter.getEpoch();

        // 进程死亡：连接断开；新进程的连接视为重新可用
        pair.client.simulateClose?.(1);
        pair.client.reopen?.();
        expect(adapter.isConnected()).toBe(false);

        // 下一次发送触发自动重启（退避后 spawn 新进程）
        const sessionId = await adapter.createSession('C:\\vault');
        expect(sessionId).toBe('sid-2');
        expect(adapter.isConnected()).toBe(true);
        expect(adapter.getEpoch()).toBe(epoch1 + 1);
    });

    it('重启后 sendMessage 流式正常（完整链路）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let sessionSeq = 0;
        let promptSeq = 0;
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') {
                sessionSeq += 1;
                server.respond(msg.id!, { sessionId: `sid-${sessionSeq}` });
            } else if (msg.method === 'session/prompt') {
                promptSeq += 1;
                const text = promptSeq === 1 ? '你好' : '世界';
                server.notify('session/update', {
                    sessionId: `sid-${sessionSeq}`,
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
                });
                server.respond(msg.id!, { stopReason: 'end_turn' });
            }
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });

        const collect = async (sessionId: string, content: string): Promise<string> => {
            const out: string[] = [];
            for await (const chunk of adapter.sendMessage(sessionId, { content }, {})) {
                if (chunk.type === 'text') out.push(chunk.content);
            }
            return out.join('');
        };

        const sid1 = await adapter.createSession('C:\\vault');
        expect(await collect(sid1, 'first')).toBe('你好');

        pair.client.simulateClose?.(1);
        pair.client.reopen?.();

        // 自愈重启后新 session 照常流式
        const sid2 = await adapter.createSession('C:\\vault');
        expect(sid2).toBe('sid-2');
        expect(await collect(sid2, 'second')).toBe('世界');
    });

    it('重启失败 → 每次发送退避一次，超过上限给出明确错误', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let initCount = 0;
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                initCount += 1;
                if (initCount === 1) {
                    server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
                }
                // 重启后的 initialize 不响应 → 请求超时失败
            } else if (msg.method === 'session/new') {
                server.respond(msg.id!, { sessionId: 'sid-1' });
            }
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 30 });
        expect(adapter.isConnected()).toBe(true);

        pair.client.simulateClose?.(1);

        // 前 MAX_RESTART_ATTEMPTS 次：每次各做一次自动重启，均失败
        for (let i = 0; i < MAX_RESTART_ATTEMPTS; i++) {
            await expect(adapter.createSession('C:\\vault')).rejects.toThrow(/超时|未就绪/);
            expect(adapter.isConnected()).toBe(false);
        }
        // 超过上限：给出「反复退出」的明确错误，不再继续无谓重试
        await expect(adapter.createSession('C:\\vault')).rejects.toThrow(/反复退出/);
    });

    it('并发发送共享同一次重启（单飞锁，不重复 spawn）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let initCount = 0;
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') initCount += 1; // 只统计 initialize，排除 session/new
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 'sid' });
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        pair.client.simulateClose?.(1);
        pair.client.reopen?.();

        const [a, b] = await Promise.all([
            adapter.createSession('C:\\vault'),
            adapter.createSession('C:\\vault'),
        ]);
        expect(a).toBe('sid');
        expect(b).toBe('sid');
        expect(initCount).toBe(2); // 首次 initialize + 一次重启（而非两次并发重启）
    });

    it('重复 initialize：显式关闭旧进程后重建（S7，覆盖旧 client.close 分支）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => initHandler(server, msg);
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 100 });
        const e1 = adapter.getEpoch();

        // 第二次 initialize：旧进程被显式关闭（传输随之关闭），新客户端在关闭的传输上超时
        // ——仍覆盖「重新初始化前先 dispose 旧进程」的 close 分支。
        await expect(adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 100 }))
            .rejects.toThrow(/超时/);
        expect(adapter.getEpoch()).toBe(e1); // 失败的重初始化不推进代际
    });

    it('setPermissionHandler：四类 option kind 映射到适配层', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let seen: PermissionOptionKind[] = [];
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 'sid' });
            else if (msg.method === 'session/prompt') {
                server.transport.write(JSON.stringify({
                    jsonrpc: '2.0', id: 9001, method: 'session/request_permission',
                    params: {
                        sessionId: 'sid', toolCall: { toolCallId: 'tc-1' },
                        options: [
                            { optionId: 'a', name: 'A', kind: 'allow_once' },
                            { optionId: 'b', name: 'B', kind: 'allow_always' },
                            { optionId: 'c', name: 'C', kind: 'reject_once' },
                            { optionId: 'd', name: 'D', kind: 'reject_always' },
                        ],
                    },
                }) + '\n');
                server.respond(msg.id!, { stopReason: 'end_turn' });
            } else if (msg.method === 'session/cancel') {
                server.respond(msg.id!, {});
            }
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        adapter.setPermissionHandler(async (req) => {
            seen = req.options.map(o => o.kind);
            return { outcome: 'cancelled' };
        });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        const sid = await adapter.createSession('C:\\vault');
        for await (const _chunk of adapter.sendMessage(sid, { content: 'x' }, {})) { /* drain */ }
        expect(seen).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
    });

    it('dispose 关闭活跃客户端', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => initHandler(server, msg);
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        expect(adapter.isConnected()).toBe(true);
        await adapter.dispose();
        expect(adapter.isConnected()).toBe(false);
        // dispose 幂等
        await adapter.dispose();
    });

    it('sendMessage 超时：服务器不响应 prompt → 产出超时错误（含取消落定）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 'sid' });
            else if (msg.method === 'session/cancel') server.respond(msg.id!, {});
            // session/prompt 不响应 → 触发适配层超时
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 30 });
        const sid = await adapter.createSession('C:\\vault');

        const chunks: string[] = [];
        for await (const chunk of adapter.sendMessage(sid, { content: 'slow' }, {})) {
            if (chunk.type === 'error') chunks.push(chunk.content);
        }
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain('超时');
        expect(adapter.isConnected()).toBe(true); // 超时不杀进程
    });

    it('sendMessage RPC 错误：prompt 返回 error → 产出错误 chunk', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 'sid' });
            else if (msg.method === 'session/prompt') server.respondError(msg.id!, '模型不可用');
        };
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        const sid = await adapter.createSession('C:\\vault');

        const chunks: string[] = [];
        for await (const chunk of adapter.sendMessage(sid, { content: 'x' }, {})) {
            if (chunk.type === 'error') chunks.push(chunk.content);
        }
        expect(chunks).toEqual(['模型不可用']);
    });

    it('diagnose：未连接 / 已连接 / 断开(stale) 三种状态', async () => {
        // 未初始化
        const fresh = new DeepSeekBridgeAdapter();
        const d0 = await fresh.diagnose();
        expect(d0.status).toBe('error');
        expect(d0.checks.find(c => c.name === 'ACP 进程')?.passed).toBe(false);

        // 已连接
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => initHandler(server, msg);
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        await adapter.initialize({ command: 'mock', vaultPath: 'C:\\vault', timeoutMs: 1000 });
        const d1 = await adapter.diagnose();
        expect(d1.status).toBe('ok');
        expect(d1.checks.find(c => c.name === 'ACP 进程')?.message).toBe('已连接');

        // 进程意外退出（stale）
        pair.client.simulateClose?.(1);
        const d2 = await adapter.diagnose();
        expect(d2.status).toBe('error');
        const procCheck = d2.checks.find(c => c.name === 'ACP 进程')!;
        expect(procCheck.message).toContain('已断开');
    });

    it('diagnose：DSH 可执行文件缺失给出 fix', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => initHandler(server, msg);
        const adapter = new DeepSeekBridgeAdapter({ transport: pair.client, restartDelayBaseMs: 1 });
        // 绝对路径指向不存在的可执行文件：非 bare command，必判失败
        // 用 path.resolve 生成跨平台绝对路径（Z:\ 仅 Windows 才视为绝对，Linux 下会被误判为 bare command）
        const missingExe = path.resolve('definitely-missing-dsh.exe');
        await adapter.initialize({ command: `${missingExe} --profile acp`, vaultPath: 'C:\\vault', timeoutMs: 1000 });
        const d = await adapter.diagnose();
        const exe = d.checks.find(c => c.name === 'DSH 可执行文件')!;
        expect(exe.passed).toBe(false);
        expect(exe.fix).toContain('找不到该命令');
    });
});

// ==================== 命令解析/文件解析增补（Phase 2.4 补覆盖） ====================

describe('resolveExecutable / isBareCommand / resolveShimTarget 增补', () => {
    it('带扩展名的相对路径存在时直接返回（如 package.json）', () => {
        expect(resolveExecutable('package.json')).toBe('package.json');
    });

    it('isBareCommand：无扩展名且不存在 → true；存在/绝对路径 → false', () => {
        expect(isBareCommand('dsh-no-such-cmd')).toBe(true);
        expect(isBareCommand('package.json')).toBe(false);
        expect(isBareCommand(path.resolve('package.json'))).toBe(false);
    });

    it('resolveShimTarget：读取失败 → null', () => {
        expect(resolveShimTarget(path.join(os.tmpdir(), 'bbd-no-such-shim-xyz.cmd'))).toBeNull();
    });

    it('resolveShimTarget：内容无 node_modules 路径 → null', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbd-shim-'));
        const shim = path.join(dir, 'x.cmd');
        fs.writeFileSync(shim, '@echo off\r\n');
        try {
            expect(resolveShimTarget(shim)).toBeNull();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('resolveShimTarget：匹配到但目标不存在 → null；存在 → 返回目标', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbd-shim2-'));
        try {
            const missing = path.join(dir, 'missing.cmd');
            fs.writeFileSync(missing, `@IF EXIST "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" (\r\n`);
            expect(resolveShimTarget(missing)).toBeNull();

            // 目标真实存在（用测试文件自身充当 js 入口）
            const target = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '// ok');
            const ok = path.join(dir, 'ok.cmd');
            fs.writeFileSync(ok, `node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`);
            const resolved = resolveShimTarget(ok);
            expect(resolved).not.toBeNull();
            expect(path.basename(resolved!)).toBe('bin.js');
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('resolveAcpCommand：.ps1 走 powershell.exe -File（Windows）', () => {
        if (process.platform !== 'win32') return;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbd-ps1-'));
        const oldPath = process.env.PATH;
        try {
            const script = path.join(dir, 'acp.ps1');
            fs.writeFileSync(script, 'Write-Output "mock"');
            process.env.PATH = dir;
            const resolved = resolveAcpCommand('acp.ps1');
            expect(resolved.program.toLowerCase()).toContain('powershell');
            expect(resolved.args).toContain('-File');
            expect(resolved.args).toContain(script);
            expect(resolved.shell).toBe(false);
        } finally {
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});

// ==================== createVaultToolContext（2.4 补覆盖） ====================

describe('createVaultToolContext', () => {
    type VaultMock = {
        read: (p: string) => Promise<string>;
        modify: (p: string, c: string) => Promise<void>;
        create: (p: string, c: string) => Promise<void>;
        exists: (p: string) => Promise<boolean>;
        getFiles: () => Array<{ path: string; basename: string; extension: string }>;
        adapter: { basePath?: string };
    };

    const makeVault = (overrides: Partial<VaultMock> = {}): VaultMock => {
        const base: VaultMock = {
            read: jest.fn(async (p: string) => p === 'a.md' ? '# A' : 'x'),
            modify: jest.fn(async () => undefined),
            create: jest.fn(async () => undefined),
            exists: jest.fn(async (p: string) => p === 'a.md' || p === 'exists.md'),
            getFiles: jest.fn(() => [
                { path: 'notes/alpha.md', basename: 'alpha', extension: 'md' },
                { path: 'docs/beta.md', basename: 'beta', extension: 'md' },
            ]),
            adapter: { basePath: 'C:\\vault' },
        };
        return { ...base, ...overrides };
    };

    it('readNote：存在返回内容，不存在返回 null，异常返回 null', async () => {
        const ctx = createVaultToolContext(makeVault());
        expect(await ctx.readNote('a.md')).toBe('# A');
        expect(await ctx.readNote('missing.md')).toBeNull();
        const err = createVaultToolContext(makeVault({ read: jest.fn(async () => { throw new Error('io'); }) }));
        expect(await err.readNote('a.md')).toBeNull();
    });

    it('writeNote：存在 → modify，不存在 → create，异常 → 错误对象', async () => {
        const vault = makeVault();
        const ctx = createVaultToolContext(vault);
        expect(await ctx.writeNote('exists.md', 'c')).toEqual({ ok: true });
        expect(vault.modify).toHaveBeenCalledWith('exists.md', 'c');
        expect(await ctx.writeNote('new.md', 'c')).toEqual({ ok: true });
        expect(vault.create).toHaveBeenCalledWith('new.md', 'c');
        const err = createVaultToolContext(makeVault({ create: jest.fn(async () => { throw new Error('perm'); }) }));
        expect(await err.writeNote('new.md', 'c')).toEqual({ ok: false, error: 'perm' });
    });

    it('searchVault：按路径/文件名匹配，受 limit 限制', async () => {
        const ctx = createVaultToolContext(makeVault());
        expect(await ctx.searchVault('ALPHA', 5)).toEqual([{ path: 'notes/alpha.md' }]); // 大小写不敏感
        expect(await ctx.searchVault('beta', 5)).toEqual([{ path: 'docs/beta.md' }]);
        expect(await ctx.searchVault('a', 1)).toHaveLength(1); // limit：'a' 命中首文件即停
    });
});
