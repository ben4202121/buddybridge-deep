# BuddyBridge Deep

> 第三方 Obsidian 插件 · 通过 ACP 桥接 DeepSeek Harness (DSH)
> Unofficial Obsidian plugin · Bridges DeepSeek Harness via ACP

在 Obsidian 里直接和 DeepSeek Harness 对话：流式回复、思考过程、工具调用、多轮会话，并**自动复用 DSH Web 的 API Key 与地址**，开箱即用。

Chat with DeepSeek Harness inside Obsidian — streaming replies, thinking blocks, tool calls, multi-turn sessions, and **zero-config reuse of your DSH Web API key & base URL**.

---

## 功能 Features

| 功能 | Features |
| :--- | :--- |
| 流式聊天面板（停止 / 重试） | Streaming chat with stop / retry |
| 可折叠思考块与工具调用卡 | Collapsible thinking blocks & tool-call cards |
| 每对话一个 DSH 会话，多轮上下文连贯 | One DSH session per conversation, multi-turn context |
| 上下文注入：笔记路径 / 全文 / Vault 根路径（可开关） | Context injection: note path / full content / vault root (toggles) |
| 工具调用权限弹窗 | Permission modal for tool calls |
| 断链自动重连（指数退避） | Auto-reconnect with exponential backoff |
| 双语界面（简体中文 / English，跟随 Obsidian） | Bilingual UI (zh / en, follows Obsidian) |
| **自动读取 DSH Web 凭据与地址，零配置** | **Auto-reads DSH Web API key & base URL — no manual setup** |
| 会话分叉 / 附加笔记 / 上下文占用指示 | Fork conversations / attach notes / context usage meter |
| 设置与聊天记录导出 / 导入 | Export / import settings & chat history |
| 一键后端配置脚本 | One-click backend setup script |

## 安装 Installation

### 1. 前置：DeepSeek Harness + ACP profile

本插件通过标准 **ACP (Agent Client Protocol)** stdio JSON-RPC 与 DSH 通信，需要本机已安装
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）并装配 ACP profile。

已装 `dsh` 的用户可一键装配（推荐）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-acp.ps1
```

脚本会自动安装配套的 `@deepseek-ai/dsh-acp-demo` 到 `~/.dsh/profiles/acp`、编译 koffi 原生库并生成
`cordis.yml`，最后打印实际启动命令，形如：

```text
node C:\Users\<you>\.dsh\profiles\acp\node_modules\@deepseek-ai\dsh-acp-demo\lib\bin.js -c C:\Users\<you>\.dsh\profiles\acp\cordis.yml
```

> 注意：`dsh --profile acp` **不会**加载 ACP 服务器——demo 包不是 profile bundle，必须用上面的独立 bin 命令。

### 2. 安装插件本体

1. 复制 `main.js` / `manifest.json` / `styles.css` 到 `<你的Vault>/.obsidian/plugins/buddybridge-deep/`
2. Obsidian 设置 → 第三方插件 → 开启「BuddyBridge Deep」
3. 设置页 →「DSH ACP 命令」填好启动命令 → 点「诊断连接」验证

## 配置 Configuration

设置 → BuddyBridge Deep：

| 项 | 说明 | Setting |
| :--- | :--- | :--- |
| DSH ACP 命令 | 启动 ACP stdio 服务器的命令 | ACP start command |
| DeepSeek API Key | **留空自动读取 DSH Web**（~/.dsh/.credentials.yaml） | Auto-read from DSH Web when empty |
| DeepSeek Base URL | **留空自动读取 DSH Web**（~/.dsh/settings.yaml），如火山方舟 | Auto-read from DSH Web when empty |
| 请求超时 | 单次请求超时秒数 | Request timeout |
| 上下文注入 | 笔记路径 / 全文 / Vault 根路径开关 | Context injection toggles |
| 外观 | 主色调 / 字体大小 | Primary color / font size |
| 界面语言 | 简体中文 / English / 跟随 Obsidian | Language |
| 管理 | 最大对话数 / 导出 / 导入 / 重置 | Max conversations / export / import / reset |

> **零配置凭据**：DSH Web 已能对话的话，插件会直接复用它的 API Key 与 Base URL（读
> `~/.dsh/.credentials.yaml` 与 `~/.dsh/settings.yaml`），无需在插件里重复填写。

## 开发 Development

```bash
npm install          # 安装依赖
npm run build        # tsc 类型检查 + esbuild 打包 → main.js
npm test             # jest：239 个用例（含 ACP 客户端端到端集成测试），80% 覆盖率门禁
npm run dev          # 监听模式（esbuild --watch）
```

独立冒烟脚本（不依赖 Obsidian）：

```bash
node scripts/acp-smoke.mjs --command "dsh --profile acp" --cwd "C:\your\vault"
```

## 架构 Architecture

```
src/
├── core/                # 共享抽象层：bridge-adapter / stream-chunk / vault-tools
│   ├── dsh-env.ts       # DSH 全局 .env 读写（~/.dsh/.env）
│   └── dsh-shared.ts    # 自动读取 DSH Web 凭据与地址（credentials.yaml / settings.yaml）
├── bridges/deep/        # DeepSeek 适配层：ACP JSON-RPC stdio 客户端 + 命令解析
├── chat/manager.ts      # 会话管理
├── settings/            # 设置页、确认/权限弹窗、诊断、一键后端配置
├── views/chat.ts        # 聊天视图（流式、思考/工具块、错误卡重试）
├── context.ts / io.ts   # 上下文注入 / 导出导入
└── main.ts              # 插件入口
```

## 已知限制 Known Limitations

- 官方 `@deepseek-ai/dsh-acp` 自动化仅支持 **fresh sessions**：无 `session/load` / `session/list` / `session/fork`（插件重载后每对话新建会话）。
- 权限「始终允许」依赖服务器是否提供 `allow_always` 选项（官方默认仅 allow-once / reject-once）。
- 思考过程是否可见取决于 ACP 服务器是否发送 `agent_thought_chunk`。

## License

MIT
