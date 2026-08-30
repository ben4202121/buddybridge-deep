import {
    contentToText,
    contentBlockToText,
    parseAcpUpdate,
    parsePromptResult,
    extractRpcError,
    SessionStream,
    AcpClient,
    createMemoryTransportPair,
} from '../src/bridges/deep/acp-client';
import type { StreamChunk } from '../src/core/stream-chunk';
import {
    splitCommand,
    resolveExecutable,
    resolveAcpCommand,
} from '../src/bridges/deep/cli';
import { MockAcpServer, initHandler } from './helpers/mock-acp-server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('contentBlockToText', () => {
    it('extracts text block', () => {
        expect(contentBlockToText({ type: 'text', text: 'hello' })).toBe('hello');
    });
    it('returns empty string for empty text block', () => {
        expect(contentBlockToText({ type: 'text' })).toBe('');
    });
    it('returns null for non-text blocks', () => {
        expect(contentBlockToText({ type: 'image', data: 'x', mimeType: 'image/png' })).toBeNull();
        expect(contentBlockToText('nope')).toBeNull();
        expect(contentBlockToText(null)).toBeNull();
    });
});

describe('contentToText', () => {
    it('joins an array of text blocks', () => {
        expect(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
    });
    it('skips non-text blocks in an array', () => {
        expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }])).toBe('a');
    });
    it('handles a single block', () => {
        expect(contentToText({ type: 'text', text: 'solo' })).toBe('solo');
    });
    it('returns empty for garbage', () => {
        expect(contentToText(undefined)).toBe('');
        expect(contentToText(42)).toBe('');
    });
});

describe('parseAcpUpdate (真实 @deepseek-ai/dsh-acp 格式)', () => {
    it('parses agent_message_chunk with single content block', () => {
        const chunk = parseAcpUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
        });
        expect(chunk).toEqual({ type: 'text', content: '你好' });
    });

    it('parses agent_thought_chunk as thinking', () => {
        const chunk = parseAcpUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考中' } },
        });
        expect(chunk).toEqual({ type: 'thinking', content: '思考中' });
    });

    it('parses tool_call with toolCallId/rawInput', () => {
        const chunk = parseAcpUpdate({
            sessionId: 's1',
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc1',
                name: 'read_note',
                rawInput: { path: 'a.md' },
            },
        });
        expect(chunk).toEqual({
            type: 'tool',
            toolName: 'read_note',
            toolDetail: JSON.stringify({ path: 'a.md' }),
            toolCallId: 'tc1',
        });
    });

    it('parses error update', () => {
        const chunk = parseAcpUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'error', message: '模型错误' },
        });
        expect(chunk).toEqual({ type: 'error', content: '模型错误' });
    });

    it('parses done', () => {
        const chunk = parseAcpUpdate({ sessionId: 's1', update: { sessionUpdate: 'session_ended' } });
        expect(chunk).toEqual({ type: 'done' });
    });

    it('ignores user_message_chunk echo', () => {
        expect(parseAcpUpdate({ sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } } })).toBeNull();
    });

    it('returns null for unknown params', () => {
        expect(parseAcpUpdate(null)).toBeNull();
        expect(parseAcpUpdate('x')).toBeNull();
        expect(parseAcpUpdate({})).toBeNull();
    });
});

describe('parseAcpUpdate (兼容简化格式 / 方案文档)', () => {
    it('parses type + chunk.text', () => {
        const chunk = parseAcpUpdate({ sessionId: 's1', type: 'agent_message_chunk', chunk: { text: '简化' } });
        expect(chunk).toEqual({ type: 'text', content: '简化' });
    });

    it('parses tool with tool.name/arguments/id', () => {
        const chunk = parseAcpUpdate({
            sessionId: 's1',
            type: 'tool_call',
            tool: { name: 'write_note', arguments: '{"path":"a"}', id: 't1' },
        });
        expect(chunk).toEqual({ type: 'tool', toolName: 'write_note', toolDetail: '{"path":"a"}', toolCallId: 't1' });
    });
});

describe('parsePromptResult', () => {
    it('extracts stopReason and usage', () => {
        const result = parsePromptResult({
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, thoughtTokens: 3 },
        });
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage).toEqual({
            inputTokens: 10, outputTokens: 5, totalTokens: 15,
            thoughtTokens: 3, cachedReadTokens: undefined, cachedWriteTokens: undefined,
        });
    });
    it('defaults stopReason when absent', () => {
        expect(parsePromptResult(undefined).stopReason).toBe('end_turn');
        expect(parsePromptResult({}).stopReason).toBe('end_turn');
    });
});

describe('extractRpcError', () => {
    it('combines message and data', () => {
        expect(extractRpcError({ message: 'invalid params', data: 'cwd must be absolute' }))
            .toBe('invalid params: cwd must be absolute');
    });
    it('returns message only', () => {
        expect(extractRpcError({ message: 'boom' })).toBe('boom');
    });
    it('returns fallback', () => {
        expect(extractRpcError('nope')).toBe('未知 RPC 错误');
    });
});

describe('SessionStream', () => {
    it('yields pushed chunks in order then completes', async () => {
        const stream = new SessionStream();
        stream.push({ type: 'text', content: 'a' });
        stream.push({ type: 'text', content: 'b' });
        stream.end();
        const out: string[] = [];
        for await (const chunk of stream) {
            out.push((chunk as { content: string }).content);
        }
        expect(out).toEqual(['a', 'b']);
    });

    it('yields chunks pushed after iteration starts', async () => {
        const stream = new SessionStream();
        const collected: string[] = [];
        const task = (async () => {
            for await (const chunk of stream) {
                collected.push((chunk as { content: string }).content);
            }
        })();
        stream.push({ type: 'text', content: 'late' });
        stream.end();
        await task;
        expect(collected).toEqual(['late']);
    });

    it('ignores pushes after end', async () => {
        const stream = new SessionStream();
        stream.end();
        stream.push({ type: 'text', content: 'ignored' });
        const out: string[] = [];
        for await (const chunk of stream) {
            out.push((chunk as { content: string }).content);
        }
        expect(out).toEqual([]);
    });
});

describe('splitCommand', () => {
    it('splits simple command', () => {
        expect(splitCommand('dsh --profile acp')).toEqual({ program: 'dsh', args: ['--profile', 'acp'] });
    });
    it('handles quoted args with spaces', () => {
        expect(splitCommand('node "C:\\my app\\server.js" -c "a b"')).toEqual({
            program: 'node',
            args: ['C:\\my app\\server.js', '-c', 'a b'],
        });
    });
    it('handles empty command', () => {
        expect(splitCommand('')).toEqual({ program: '', args: [] });
    });
});

describe('resolveAcpCommand', () => {
    it('defaults to dsh --profile acp when empty', () => {
        const resolved = resolveAcpCommand('');
        expect(resolved.program).toBeTruthy();
        expect(resolved.args).toContain('--profile');
        expect(resolved.args).toContain('acp');
    });
    it('splits a custom command', () => {
        const resolved = resolveAcpCommand('node server.js');
        // 命令解析会尝试把 node 解析为绝对路径；断言 args 与可执行性即可
        expect(resolved.args).toEqual(['server.js']);
        expect(resolved.program === 'node' || resolved.program.includes('node')).toBe(true);
    });
});

describe('resolveExecutable', () => {
    it('returns absolute existing path', () => {
        // 使用当前测试文件作为存在的绝对路径
        const me = __filename;
        expect(resolveExecutable(me)).toBe(me);
    });
    it('returns null for nonexistent absolute path', () => {
        expect(resolveExecutable('Z:\\definitely\\not\\here\\x.exe')).toBeNull();
    });
    it('resolves PATH entry (node)', () => {
        const resolved = resolveExecutable('node');
        // node 应能在 PATH 中找到；找不到则至少返回 null 而非崩溃
        expect(typeof resolved).toBe('string');
    });

    // 回归：Windows 上无扩展名 npm shim 不可 spawn，必须优先 .cmd/.exe（bug: 选中 dsh 而非 dsh.cmd 导致 ENOENT）
    it('prefers .cmd/.exe over extensionless shim on Windows', () => {
        if (process.platform !== 'win32') return;
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbd-resolve-'));
        const oldPath = process.env.PATH;
        try {
            // 模拟 npm 全局目录：同时存在 dsh（无扩展名 shim）与 dsh.cmd
            const bare = path.join(tmp, 'dsh');
            const cmd = path.join(tmp, 'dsh.cmd');
            fs.writeFileSync(bare, '');
            fs.writeFileSync(cmd, '@echo off\r\n');
            process.env.PATH = tmp;
            expect(resolveExecutable('dsh')).toBe(cmd);
        } finally {
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});

// ==================== 生命周期/传输层增补（Phase 2.4 补覆盖） ====================

describe('AcpClient 生命周期与传输层增补', () => {
    it('resource_link 块文本化 / 无 uri 返回 null', () => {
        expect(contentBlockToText({ type: 'resource_link', name: 'a', uri: 'file:///x.md' }))
            .toBe('[resource_link name="a" uri="file:///x.md"]');
        expect(contentBlockToText({ type: 'resource_link', name: 'a' })).toBeNull();
    });

    it('未知 update 类型（有 type 但未识别）→ null', () => {
        expect(parseAcpUpdate({ sessionId: 's', update: { sessionUpdate: 'weird_event' } })).toBeNull();
    });

    it('未启动时 RPC 立即拒绝；关闭后 cancel/cancelAll 静默返回', async () => {
        const client = new AcpClient({ program: 'mock', args: [] });
        await expect(client.initialize()).rejects.toThrow('ACP 进程未运行');
        await expect(client.newSession('C:\\vault')).rejects.toThrow('ACP 进程未运行');
        await expect(client.cancel('s')).resolves.toBeUndefined();
        await expect(client.cancelAll()).resolves.toBeUndefined();
        await client.close(); // 未启动时 close 也安全（transport 为 null）
        // prompt 在未启动时：流立即结束 + result 拒绝
        const { result, stream } = client.prompt('s', 'x');
        const collected: StreamChunk[] = [];
        for await (const c of stream) collected.push(c);
        expect(collected).toEqual([]);
        await expect(result).rejects.toThrow('ACP 进程未运行');
    });

    it('start() 幂等：重复调用直接 resolve', async () => {
        const pair = createMemoryTransportPair();
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client });
        await client.start();
        await expect(client.start()).resolves.toBeUndefined();
    });

    it('initialize 携带 protocolVersion: 1（官方 SDK 必填，缺失 → -32602 Invalid params）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let initParams: unknown;
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                initParams = msg.params;
                server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
            }
        };
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client });
        await client.start();
        await client.initialize();
        expect(initParams).toMatchObject({ protocolVersion: 1 });
    });

    it('同会话第二个 prompt 拒绝（单 in-flight）', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        const promptIds: number[] = [];
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') server.respond(msg.id!, { sessionId: 's' });
            else if (msg.method === 'session/prompt') promptIds.push(msg.id!); // 保持 in-flight，不响应
        };
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 1000 });
        await client.start();
        await client.initialize();
        const sid = await client.newSession('C:\\vault');

        const p1 = client.prompt(sid, 'one');
        const p2 = client.prompt(sid, 'two');
        // 第二个 prompt 未写入线路（请求数仍为 1），且 result 直接拒绝
        expect(promptIds.length).toBe(1);
        await expect(p2.result).rejects.toThrow('该会话已有进行中的请求');
        server.respond(promptIds[0], { stopReason: 'end_turn' });
        for await (const _c of p1.stream) { /* drain */ }
        await p1.result;
    });

    it('cancelAll 取消全部 in-flight 会话', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        const cancelled: number[] = [];
        const promptIds: number[] = [];
        let seq = 0;
        server.onRequest = (msg) => {
            initHandler(server, msg);
            if (msg.method === 'session/new') {
                seq += 1;
                server.respond(msg.id!, { sessionId: `s${seq}` });
            } else if (msg.method === 'session/prompt') {
                promptIds.push(msg.id!); // 保持 in-flight，不响应
            } else if (msg.method === 'session/cancel') {
                cancelled.push(msg.id!);
                server.respond(msg.id!, {});
            }
        };
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000 });
        await client.start();
        await client.initialize();
        const s1 = await client.newSession('C:\\vault');
        const s2 = await client.newSession('C:\\vault');
        client.prompt(s1, 'a');
        client.prompt(s2, 'b');
        await client.cancelAll();
        expect(cancelled.length).toBe(2);
        // 收尾：settle 两个挂起的 prompt，避免悬挂 promise
        for (const id of promptIds) server.respond(id, { stopReason: 'cancelled' });
    });

    it('handleLine：非 JSON 行与解析错误走 onLog；无匹配 id 的消息安全忽略', async () => {
        const pair = createMemoryTransportPair();
        const logs: string[] = [];
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, onLog: (m) => logs.push(m) });
        await client.start();
        pair.server.write('plain stdout line\n');
        pair.server.write('{bad json}\n');
        pair.server.write('{}\n'); // 合法 JSON，无 id/method → handleMessage 早退，不抛错
        expect(logs.some(l => l.includes('[dsh stdout]'))).toBe(true);
        expect(logs.some(l => l.includes('[dsh parse error]'))).toBe(true);
    });

    it('重复 simulateClose 幂等（onProcessClose 早退）', async () => {
        const pair = createMemoryTransportPair();
        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client });
        await client.start();
        pair.client.simulateClose?.(1);
        pair.client.simulateClose?.(2); // 已 closed + 无 proc/transport → 早退
        expect(client.isRunning).toBe(false);
    });

    it('spawn 失败（ENOENT）→ start() reject（进程未拉起）', async () => {
        const client = new AcpClient({ program: 'zzz-definitely-not-a-real-cmd-98765', args: [] });
        // spawn 一个不存在的程序：Node 触发 'error'（ENOENT）。start() 应在错误事件与 0ms tick 的
        // 竞态中 reject 或 resolve 后 isRunning 仍为 false——断言"不成功"而非精确 reject，避免平台差异。
        try {
            await client.start();
        } catch {
            /* 预期可能 reject */
        }
        expect(client.isRunning).toBe(false);
    });
});

// ==================== 真实 spawn 端到端（Phase 2.4 补覆盖 spawn 传输） ====================

/** 用 `node -e` 充当迷你 ACP 服务器：覆盖 createSpawnTransport / start / close / stderr 路径。 */
const MINI_ACP_SERVER = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') respond({ protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
    else if (msg.method === 'session/new') respond({ sessionId: 'real-sid' });
    else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'real-sid', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }) + '\\n');
      respond({ stopReason: 'end_turn' });
    }
    else respond({});
  }
});
setTimeout(() => process.stderr.write('mini-server stderr line\\n'), 50);
`;

describe('AcpClient 真实 spawn 传输', () => {
    it('start → initialize → newSession → prompt 流式 → close（含 stderr 日志）', async () => {
        const logs: string[] = [];
        const client = new AcpClient({
            program: process.execPath,
            args: ['-e', MINI_ACP_SERVER],
            requestTimeoutMs: 3000,
            onLog: (m) => logs.push(m),
        });
        await client.start();
        await client.initialize();
        const sid = await client.newSession('C:\\vault');
        expect(sid).toBe('real-sid');

        const { result, stream } = client.prompt(sid, 'hi');
        const text: string[] = [];
        for await (const c of stream) {
            if (c.type === 'text') text.push(c.content);
        }
        expect(text.join('')).toBe('hi');
        await result;

        // 子进程 stderr → onStderrData → onLog（轮询等待，最多 2s）
        for (let i = 0; i < 100 && !logs.some(l => l.includes('stderr')); i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        expect(logs.some(l => l.includes('stderr'))).toBe(true);

        await client.close();
        expect(client.isRunning).toBe(false);
    });

    it('env 注入：opts.env 合并进子进程环境（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 到达子进程，PATH 等仍继承）', async () => {
        // 迷你服务器把收到的 process.env.DEEPSEEK_API_KEY 与 DEEPSEEK_BASE_URL 原样回显为 text chunk（4.2 地址共用）
        const ECHO_ENV_SERVER = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') respond({ protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
    else if (msg.method === 'session/new') respond({ sessionId: 'env-sid' });
    else if (msg.method === 'session/prompt') {
      const key = process.env.DEEPSEEK_API_KEY || '(absent)';
      const base = process.env.DEEPSEEK_BASE_URL || '(absent)';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'env-sid', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: key + '|' + base } } } }) + '\\n');
      respond({ stopReason: 'end_turn' });
    }
    else respond({});
  }
});
`;
        const client = new AcpClient({
            program: process.execPath,
            args: ['-e', ECHO_ENV_SERVER],
            requestTimeoutMs: 3000,
            env: {
                DEEPSEEK_API_KEY: 'sk-test-injected-12345',
                DEEPSEEK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
            },
        });
        await client.start();
        await client.initialize();
        const sid = await client.newSession('C:\\vault');
        const { result, stream } = client.prompt(sid, 'hi');
        const text: string[] = [];
        for await (const c of stream) {
            if (c.type === 'text') text.push(c.content);
        }
        expect(text.join('')).toBe('sk-test-injected-12345|https://ark.cn-beijing.volces.com/api/coding/v3');
        await result;
        await client.close();
    });
});
