# 更新日志 / Changelog

## 0.3.0 (2026-09-23)

### 新增 / Added

- **会话拥有文件访问能力，AI 可读写与搜索知识库。**
  - `buildCordisYml` 新增三个内置工具插件 —— `subprocess`、`tool-fs`（读 / 写 / 编辑）、`tool-fs-search`（glob / grep），并按顺序排在 `acp-demo` 之前。
  - 修复文件 / 命令工具此前一律返回 `unknown tool`、导致无法管理 llmwiki 知识库的问题。
  - 无需修改 `package.json`，也无需额外安装（由 DSH 扁平 fallback 目录解析）。
- **Sessions now have file access, so the AI can read, write, and search the knowledge base.**
  - `buildCordisYml` mounts three in-box tool plugins — `subprocess`, `tool-fs` (read/write/edit), and `tool-fs-search` (glob/grep) — ordered before `acp-demo`.
  - Fixes file/command tools previously returning `unknown tool`, which blocked managing the llmwiki vault.
  - No `package.json` change or extra install needed (resolved via DSH's flat fallback directory).

### 测试 / Tests

- 新增单测，断言新条目存在且排在 `acp-demo` 之前；真机清单见 `测试清单-读知识库-v1.1-2026-09-23.md`。
- New unit test asserting the entries exist and precede `acp-demo`; see the real-machine checklist.

## 0.2.0 (2026-08-29)

- 首个 ACP 桥接版本：流式回复、思考块、工具调用、会话管理、断链自愈、权限弹窗、双语 UI、一键后端配置。
- Initial ACP bridge release: streaming, thinking blocks, tool calls, session management, auto-reconnect, permission modal, bilingual UI, one-click backend setup.