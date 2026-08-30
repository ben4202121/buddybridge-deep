import type { AcpTransport } from '../../src/bridges/deep/acp-client';

// ==================== 进程内模拟 ACP 服务器（cli / acp-client 测试共用） ====================

export interface WireMessage {
    jsonrpc: string;
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}

export class MockAcpServer {
    transport: AcpTransport;
    onRequest: ((msg: WireMessage) => void) | null = null;

    constructor(transport: AcpTransport) {
        this.transport = transport;
        transport.onLine((line) => {
            const msg = JSON.parse(line) as WireMessage;
            // 客户端对 request_permission 的响应带有 result.outcome → 测试侧不关心
            if (msg.id !== undefined && msg.result && typeof msg.result === 'object') {
                const r = msg.result as { outcome?: unknown };
                if (r.outcome) return;
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

/** 标准 initialize 应答（多数用例复用）。 */
export function initHandler(server: MockAcpServer, msg: WireMessage): void {
    if (msg.method === 'initialize') {
        server.respond(msg.id!, { protocolVersion: 1, agentInfo: {}, agentCapabilities: {}, authMethods: [] });
    }
}
