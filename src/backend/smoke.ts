// ==================== ACP 冒烟检验（Phase 1.1） ====================
// 用装配出的 acpCommand 真正拉起 ACP 服务器：start → initialize → newSession → prompt(探测)。
// 非致命：prompt 失败（如未配置 API key）只报 warning，不判设置失败。

import { AcpClient } from '../bridges/deep/acp-client';
import { splitCommand } from '../bridges/deep/cli';
import { getErrorMessage } from '../types';
import { friendlyError } from '../i18n';

export interface SmokeOptions {
    command: string;
    cwd?: string;
    /** 单次 RPC 超时，默认 15s；整个冒烟有总预算。 */
    timeoutMs?: number;
    /** 探测文本，默认 "ping"（验证完整链路：流式回复 + stopReason）。 */
    probe?: string;
    /** 追加到 ACP 进程环境变量的键值（如 DEEPSEEK_API_KEY），冒烟时与插件一致的注入。 */
    env?: NodeJS.ProcessEnv;
    onLog?: (message: string) => void;
}

export interface SmokeResult {
    ok: boolean;
    /** 已进行到的阶段：initialize / session / prompt / done。 */
    stage: 'initialize' | 'session' | 'prompt' | 'done';
    detail?: string;
    warning?: string;
}

/** 运行冒烟；总预算 = 2 * timeoutMs + 5s，避免挂死。 */
export async function runAcpSmoke(opts: SmokeOptions): Promise<SmokeResult> {
    const timeoutMs = opts.timeoutMs ?? 15000;
    const { program, args } = splitCommand(opts.command || '');
    if (!program) {
        return { ok: false, stage: 'initialize', detail: 'ACP 命令为空' };
    }
    const probe = opts.probe ?? 'ping';
    const client = new AcpClient({
        program,
        args,
        cwd: opts.cwd,
        requestTimeoutMs: timeoutMs,
        env: opts.env,
        onLog: opts.onLog,
    });

    const budgetMs = 2 * timeoutMs + 5000;
    const killer = setTimeout(() => {
        void client.cancelAll().catch(() => { /* ignore */ });
        void client.close().catch(() => { /* ignore */ });
    }, budgetMs);
    killer.unref?.();

    try {
        await client.start();
        await client.initialize();
    } catch (e) {
        const detail = getErrorMessage(e);
        void client.close().catch(() => { /* ignore */ });
        clearTimeout(killer);
        return { ok: false, stage: 'initialize', detail };
    }

    let sessionId: string;
    try {
        sessionId = await client.newSession(opts.cwd);
    } catch (e) {
        clearTimeout(killer);
        // 会话创建失败也须关闭进程，避免每次失败的冒烟都泄漏一个 ACP 服务器
        void client.close().catch(() => { /* ignore */ });
        return {
            ok: false,
            stage: 'session',
            detail: `已连接 ACP 服务器，但创建会话失败：${getErrorMessage(e)}`,
        };
    }

    try {
        const { result } = client.prompt(sessionId, probe);
        const res = await result;
        clearTimeout(killer);
        return {
            ok: true,
            stage: 'done',
            detail: `流式链路正常（stopReason=${res.stopReason}）`,
        };
    } catch (e) {
        clearTimeout(killer);
        // 服务器已连上、会话可建，只是探测提示未得到回复（常见于未配 API key）→ 警告不致命
        return {
            ok: false,
            stage: 'prompt',
            warning: `服务器已就绪，但探测消息未得到回复：${friendlyError(getErrorMessage(e))}`,
        };
    } finally {
        void client.close().catch(() => { /* ignore */ });
    }
}
