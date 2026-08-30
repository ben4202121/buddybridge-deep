import { AcpClient, createMemoryTransportPair, type AcpTransport } from '../../src/bridges/deep/acp-client';

// ==================== 进程内模拟 ACP 服务器 ====================

interface WireMessage {
    jsonrpc: string;
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

class MockAcpServer {
    transport: AcpTransport;
    onRequest: ((msg: WireMessage) => void) | null = null;
    onPermissionResponse: ((msg: WireMessage) => void) | null = null;

    constructor(transport: AcpTransport) {
        this.transport = transport;
        transport.onLine((line) => {
            const msg = JSON.parse(line) as WireMessage;
            // 客户端对 request_permission 的响应带有 result.outcome
            if (msg.id !== undefined && msg.result && typeof msg.result === 'object') {
                const r = msg.result as { outcome?: unknown };
                if (r.outcome) {
                    this.onPermissionResponse?.(msg);
                    return;
                }
            }
            this.onRequest?.(msg);
        });
    }

    respond(id: number, result: unknown): void {
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    }

    respondError(id: number, message: string): void {
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
    }

    notify(method: string, params: unknown): void {
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
}

// ==================== 用例 ====================

describe('AcpClient 端到端（内存传输 + 模拟服务器）', () => {
    it('initialize → session/new → session/prompt 完整流程', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                server.respond(msg.id!, {
                    protocolVersion: 1,
                    agentInfo: { name: 'mock', version: '0.0.1' },
                    agentCapabilities: { promptCapabilities: { text: true } },
                    authMethods: [],
                });
            } else if (msg.method === 'session/new') {
                server.respond(msg.id!, { sessionId: 'sid-1' });
            } else if (msg.method === 'session/prompt') {
                server.notify('session/update', {
                    sessionId: 'sid-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
                });
                server.notify('session/update', {
                    sessionId: 'sid-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '世界' } },
                });
                server.respond(msg.id!, { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } });
            }
        };

        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000 });
        await client.start();
        await client.initialize();
        const sessionId = await client.newSession('C:\\vault');
        expect(sessionId).toBe('sid-1');

        const { result, stream } = client.prompt(sessionId, '你好');
        const text: string[] = [];
        for await (const chunk of stream) {
            if (chunk.type === 'text') text.push(chunk.content);
        }
        const res = await result;
        expect(text.join('')).toBe('你好世界');
        expect(res.stopReason).toBe('end_turn');
        expect(res.usage?.inputTokens).toBe(3);
        expect(res.usage?.outputTokens).toBe(2);
    });

    it('session/request_permission 路由到 onPermission 并回填 outcome', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let permissionResponse: WireMessage | null = null;
        server.onPermissionResponse = (msg) => { permissionResponse = msg; };
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
            } else if (msg.method === 'session/new') {
                server.respond(msg.id!, { sessionId: 'sid-2' });
            } else if (msg.method === 'session/prompt') {
                // 先发权限请求，再正常结束
                const permId = 9999;
                server.transport.write(JSON.stringify({
                    jsonrpc: '2.0', id: permId, method: 'session/request_permission',
                    params: {
                        sessionId: 'sid-2',
                        toolCall: { toolCallId: 'tc-1', title: '写文件' },
                        options: [
                            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                        ],
                    },
                }) + '\n');
                server.respond(msg.id!, { stopReason: 'end_turn' });
            }
        };

        let handlerCalls: Array<{ sessionId: string; toolCallId: string; options: unknown[] }> = [];
        const client = new AcpClient({
            program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000,
            onPermission: async (req) => {
                handlerCalls.push({ sessionId: req.sessionId, toolCallId: req.toolCallId, options: req.options });
                return { outcome: 'selected', optionId: 'allow-once' };
            },
        });
        await client.start();
        await client.initialize();
        const sessionId = await client.newSession('C:\\vault');
        const { result, stream } = client.prompt(sessionId, '写个文件');
        for await (const _chunk of stream) { /* drain */ }
        await result;

        expect(handlerCalls.length).toBe(1);
        expect(handlerCalls[0].toolCallId).toBe('tc-1');
        expect(handlerCalls[0].options.length).toBe(2);
        expect(permissionResponse).not.toBeNull();
        const outcome = permissionResponse!.result as { outcome: { outcome: string; optionId: string } };
        expect(outcome.outcome.outcome).toBe('selected');
        expect(outcome.outcome.optionId).toBe('allow-once');
    });

    it('无 onPermission 处理器时自动 cancelled', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let permissionResponse: WireMessage | null = null;
        server.onPermissionResponse = (msg) => { permissionResponse = msg; };
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
            } else if (msg.method === 'session/new') {
                server.respond(msg.id!, { sessionId: 'sid-3' });
            } else if (msg.method === 'session/prompt') {
                server.transport.write(JSON.stringify({
                    jsonrpc: '2.0', id: 7777, method: 'session/request_permission',
                    params: { sessionId: 'sid-3', toolCall: { toolCallId: 'tc-x' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }] },
                }) + '\n');
                server.respond(msg.id!, { stopReason: 'end_turn' });
            }
        };

        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000 });
        await client.start();
        await client.initialize();
        const sessionId = await client.newSession('C:\\vault');
        const { result, stream } = client.prompt(sessionId, 'x');
        for await (const _chunk of stream) { /* drain */ }
        await result;

        const outcome = permissionResponse!.result as { outcome: { outcome: string } };
        expect(outcome.outcome.outcome).toBe('cancelled');
    });

    it('RPC 错误 → request reject', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
            } else if (msg.method === 'session/new') {
                server.respondError(msg.id!, 'cwd must be an absolute path');
            }
        };

        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000 });
        await client.start();
        await client.initialize();
        await expect(client.newSession('C:\\vault')).rejects.toThrow('cwd must be an absolute path');
    });

    it('simulateClose 结束所有 pending 并让 isRunning 变 false', async () => {
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        let initCount = 0;
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                initCount++;
                if (initCount === 1) {
                    server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
                }
                // 第二次 initialize 不响应，模拟挂起请求
            }
        };

        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 5000 });
        await client.start();
        await client.initialize();
        expect(client.isRunning).toBe(true);

        const pendingInit = client.initialize();
        // 模拟「服务器进程退出」：对客户端传输端触发 close
        pair.client.simulateClose?.(1);
        await expect(pendingInit).rejects.toThrow(/已退出/);
        expect(client.isRunning).toBe(false);
    });

    it('前一 prompt 迟来的结束不误杀同会话后续 prompt 的流（cancel 竞态回归）', async () => {
        // 场景：队列泵在「取消落定」后立即复用同一 session 发下一条 prompt。
        // 服务器在 cancel 之后才迟来终结 prompt 1 → 触发 prompt 1 的 finish()。
        // 修复前 finish() 无条件 sessionStreams.delete(sid)，会把 prompt 2 的流句柄删掉，
        // 后续 chunk 被推进孤儿流，prompt 2 收不到内容（对应「停止后下一条误报错误/无响应」）。
        const pair = createMemoryTransportPair();
        const server = new MockAcpServer(pair.server);
        const promptIds: number[] = [];
        let promptCount = 0;
        server.onRequest = (msg) => {
            if (msg.method === 'initialize') {
                server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
            } else if (msg.method === 'session/new') {
                server.respond(msg.id!, { sessionId: 'sid' });
            } else if (msg.method === 'session/prompt') {
                promptCount++;
                promptIds.push(msg.id!);
                // 不立即响应：由测试体按序驱动，模拟真实异步时序
            } else if (msg.method === 'session/cancel') {
                server.respond(msg.id!, {});
            }
        };

        const client = new AcpClient({ program: 'mock', args: [], transport: pair.client, requestTimeoutMs: 2000 });
        await client.start();
        await client.initialize();
        const sessionId = await client.newSession('C:\\vault');

        // prompt 1：服务器暂不响应
        const p1 = client.prompt(sessionId, 'first');
        const p1Text: string[] = [];
        const p1Drain = (async () => { for await (const c of p1.stream) { if (c.type === 'text') p1Text.push(c.content); } })();

        // 取消落定后再发下一条（对应视图层 drainConversation 的 cancelBarriers 屏障语义）
        await client.cancel(sessionId);
        const p2 = client.prompt(sessionId, 'second');
        const p2Text: string[] = [];
        const p2Drain = (async () => { for await (const c of p2.stream) { if (c.type === 'text') p2Text.push(c.content); } })();

        // 服务器在 cancel 之后才迟来终结 prompt 1 → 触发 prompt 1 的 finish()
        server.respond(promptIds[0], { stopReason: 'cancelled' });
        await p1.result;
        await p1Drain;

        // prompt 2 的内容必须仍能到达它自己的流（修复前会被误删句柄 → 丢 chunk）
        server.notify('session/update', {
            sessionId: 'sid',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'p2-final' } },
        });
        server.respond(promptIds[1], { stopReason: 'end_turn' });
        await p2.result;
        await p2Drain;

        expect(p1Text).toEqual([]);
        expect(p2Text).toEqual(['p2-final']);
    });
});
