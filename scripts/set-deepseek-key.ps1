# ==================== 设置 DEEPSEEK_API_KEY 用户环境变量（引导式） ====================
# 用途：为 dsh-acp 的 deepseek-official provider 提供 API key。
# 运行方式：在终端执行
#   powershell -ExecutionPolicy Bypass -File scripts\set-deepseek-key.ps1
# 说明：密钥以掩码输入，不会回显；写入「当前用户」环境变量（不改机器级）。
#       设置后必须【完全退出并重新启动 Obsidian】才会生效。
# 验证：重新打开 Obsidian → 聊天发一条消息即可；或用本仓库的 acp-smoke.mjs。

$ErrorActionPreference = 'Stop'

Write-Host '=== BuddyBridge Deep: 配置 DEEPSEEK_API_KEY ===' -ForegroundColor Cyan
Write-Host '密钥只写入当前用户的系统环境变量，不会保存在任何文件或聊天记录里。' -ForegroundColor DarkGray
Write-Host '（没有 key？去 platform.deepseek.com 注册并创建 API key，通常需先充值）' -ForegroundColor DarkGray
Write-Host ''

$secure = Read-Host '请输入 DeepSeek API key（输入时打码）' -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) {
    Write-Host '未输入任何内容，已取消。' -ForegroundColor Yellow
    exit 1
}

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host '输入为空，已取消。' -ForegroundColor Yellow
    exit 1
}
if (-not $plain.StartsWith('sk-')) {
    Write-Host '警告：该值不是以 sk- 开头，可能不是有效的 DeepSeek API key，仍将写入。' -ForegroundColor Yellow
}

[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $plain.Trim(), 'User')

Write-Host ('已写入用户环境变量 DEEPSEEK_API_KEY（长度 ' + $plain.Trim().Length + '）。') -ForegroundColor Green
Write-Host '下一步：完全退出 Obsidian（确认任务管理器里 Obsidian.exe 已结束）后重新打开，再发消息测试。' -ForegroundColor Cyan
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Write-Host ('验证可选：node scripts\acp-smoke.mjs --command "node {0}\profiles\acp\node_modules\@deepseek-ai\dsh-acp-demo\lib\bin.js -c {0}\profiles\acp\cordis.yml"' -f $dshHome)
