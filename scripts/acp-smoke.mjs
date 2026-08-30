#!/usr/bin/env node
// ==================== ACP 协议冒烟测试（独立于 Obsidian） ====================
// 用法:
//   node scripts/acp-smoke.mjs [--command "dsh --profile acp"] [--cwd "C:\\vault"] [--prompt "你好"]
// 流程: initialize → session/new → session/prompt（打印流式文本）→ session/cancel（可选）
// 依赖: 一个可运行的 DSH ACP 服务器（见 README「前置：配置 DSH ACP profile」）。

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

function parseArgs(argv) {
    const out = { command: 'dsh --profile acp', cwd: process.cwd(), prompt: '用一句话介绍你自己', sendCancel: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--command') out.command = argv[++i];
        else if (a === '--cwd') out.cwd = argv[++i];
        else if (a === '--prompt') out.prompt = argv[++i];
        else if (a === '--cancel') out.sendCancel = true;
        else if (a === '--help') { console.log('用法: node scripts/acp-smoke.mjs [--command "dsh --profile acp"] [--cwd path] [--prompt text] [--cancel]'); process.exit(0); }
    }
    return out;
}

function splitCommand(cmd) {
    const tokens = [];
    let current = '', inQuote = false, started = false;
    for (const ch of cmd) {
        if (ch === '"') { inQuote = !inQuote; started = true; }
        else if ((ch === ' ' || ch === '\t') && !inQuote) {
            if (started) { tokens.push(current); current = ''; started = false; }
        } else { current += ch; started = true; }
    }
    if (started) tokens.push(current);
    return { program: tokens[0] ?? '', args: tokens.slice(1) };
}

function resolveExecutable(program) {
    if (!program) return null;
    if (path.isAbsolute(program)) return fs.existsSync(program) ? program : null;
    if (path.extname(program) && fs.existsSync(program)) return program;
    // Windows：优先 .exe/.cmd/.bat/.ps1，无扩展名 shim（npm 生成）放最后——它们无法被 Node 直接 spawn
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform === 'win32' && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    for (const dir of dirs) {
        for (const ext of exts) {
            const p = path.join(dir, program + ext);
            if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        }
    }
    return null;
}

// 解析 npm .cmd/.bat shim 里的真实 Node 入口，避免 cmd.exe（Windows 上可能不可 spawn）
function resolveShimTarget(shimPath) {
    try {
        const content = fs.readFileSync(shimPath, 'utf-8');
        const m = content.match(/node_modules[\\/]([^"%\r\n]+?\.js)/);
        if (!m) return null;
        const target = path.join(path.dirname(shimPath), 'node_modules', m[1]);
        return fs.existsSync(target) ? target : null;
    } catch { return null; }
}

let requestId = 0;
const pending = new Map();
const chunksBySession = new Map();
let inflightSession = null;

function write(proc, msg) {
    proc.stdin.write(JSON.stringify(msg) + '\n');
}

function sendRequest(proc, method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`请求超时: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write(proc, { jsonrpc: '2.0', id, method, params });
    });
}

function handleMessage(proc, raw) {
    if (!raw || typeof raw !== 'object') return;
    const id = raw.id;
    if (typeof id === 'number' && pending.has(id)) {
        const p = pending.get(id);
        pending.delete(id);
        clearTimeout(p.timer);
        if (raw.error) p.reject(new Error(JSON.stringify(raw.error)));
        else p.resolve(raw.result);
        return;
    }
    const method = raw.method;
    const params = raw.params || {};
    if (method === 'session/update') {
        const update = params.update || params;
        const kind = update.sessionUpdate || update.type || '';
        const sid = params.sessionId || '';
        if (!chunksBySession.has(sid)) chunksBySession.set(sid, []);
        const list = chunksBySession.get(sid);
        if (kind === 'agent_message_chunk' || kind === 'text') {
            const text = extractText(update.content) || (update.chunk && update.chunk.text) || update.text || '';
            if (text) list.push(text);
        } else if (kind === 'agent_thought_chunk' || /thought/.test(kind)) {
            const text = extractText(update.content) || (update.chunk && update.chunk.text) || '';
            if (text) list.push(`[思考] ${text}`);
        }
        process.stdout.write('.');
    } else if (method === 'session/request_permission') {
        const options = Array.isArray(params.options) ? params.options : [];
        const allow = options.find(o => o.kind && String(o.kind).includes('allow'));
        console.log(`\n[permission] ${params.toolCall?.toolCallId || ''} → ${allow ? '自动 allow_once' : 'reject'}`);
        write(proc, {
            jsonrpc: '2.0', id,
            result: allow
                ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
                : { outcome: { outcome: 'cancelled' } },
        });
    }
}

function extractText(content) {
    if (!content) return '';
    if (Array.isArray(content)) return content.map(extractText).join('');
    if (content && content.type === 'text') return content.text || '';
    return '';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const { program, args: progArgs } = splitCommand(args.command);
    const resolved = resolveExecutable(program) || program;
    const ext = path.extname(resolved).toLowerCase();
    let spawnProg = resolved;
    let spawnArgs = progArgs;
    let shell = false;
    // npm shim → 用 node 直接启动真实 JS 入口（绕开 cmd.exe）
    if (process.platform === 'win32' && ['.cmd', '.bat'].includes(ext)) {
        const entry = resolveShimTarget(resolved);
        if (entry) {
            spawnProg = resolveExecutable('node') || 'node';
            spawnArgs = [entry, ...progArgs];
        } else {
            shell = true;
        }
    } else if (process.platform === 'win32' && ext === '.ps1') {
        spawnProg = 'powershell.exe';
        spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...progArgs];
    }

    console.log(`[smoke] command : ${args.command}`);
    console.log(`[smoke] resolved: ${resolved} (shell=${shell})`);
    console.log(`[smoke] cwd     : ${args.cwd}`);

    const proc = spawn(spawnProg, spawnArgs, { cwd: args.cwd, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let buffer = '';
    proc.stdout.on('data', (d) => {
        buffer += d.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (!t.startsWith('{')) { console.log(`[stdout] ${t.slice(0, 120)}`); continue; }
            try { handleMessage(proc, JSON.parse(t)); } catch (e) { console.error('[parse error]', e.message); }
        }
    });
    proc.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) console.log(`[stderr] ${text.slice(0, 4000)}`);
    });
    proc.on('error', (e) => {
        console.error(`[smoke] 进程启动失败: ${e.message}`);
        console.error(`        请确认命令可执行，或安装 DSH 并配置 ACP profile（见 README）。`);
        process.exit(1);
    });

    try {
        // 1. initialize
        console.log('[smoke] initialize ...');
        const init = await sendRequest(proc, 'initialize', {
            protocolVersion: 1, // 官方 SDK zInitializeRequest 必填，缺失 → -32602 Invalid params
            capabilities: { workspace: {}, additionalDirectories: [], mcpServers: [], sessionManagement: {}, terminal: {}, promptCapabilities: { text: true }, toolSupport: {} },
        });
        console.log(`[smoke]  agentInfo: ${JSON.stringify(init?.agentInfo ?? {})}`);

        // 2. session/new
        console.log('[smoke] session/new ...');
        const created = await sendRequest(proc, 'session/new', { cwd: args.cwd, additionalDirectories: [], mcpServers: [] });
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error('session/new 未返回 sessionId');
        inflightSession = sessionId;
        console.log(`[smoke]  sessionId: ${sessionId}`);

        // 3. session/prompt
        console.log('[smoke] session/prompt ...');
        const result = await sendRequest(proc, 'session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: args.prompt }],
        }, 120000);
        console.log(`\n[smoke] stopReason: ${result?.stopReason}`);

        const text = (chunksBySession.get(sessionId) || []).join('');
        console.log(`[smoke] 收到文本(${text.length} 字符):`);
        console.log(text.slice(0, 500) || '（无文本）');

        // 4. 可选 session/cancel
        if (args.sendCancel) {
            await sendRequest(proc, 'session/cancel', { sessionId });
            console.log('[smoke] session/cancel ok');
        }

        console.log('\n[smoke] ✅ 冒烟测试通过');
    } catch (e) {
        console.error(`\n[smoke] ❌ 失败: ${e.message}`);
        process.exitCode = 1;
    } finally {
        try { proc.stdin.end(); } catch { /* ignore */ }
        const t = setTimeout(() => proc.kill(), 2000);
        proc.on('close', () => clearTimeout(t));
    }
}

main();
