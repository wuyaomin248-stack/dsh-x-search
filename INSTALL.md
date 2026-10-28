# 安装说明

dsh-x-search 是 DSH Desktop 的插件（4 个只读工具），用于在 X（twitter）上搜索与读取信息。

## 装到哪

```
<DSH 用户目录>/profiles/desktop/node_modules/dsh-x-search/
```

Windows 下 `<DSH 用户目录>` 通常是 `%USERPROFILE%\.dsh`。

开发期用 junction 指过去，改代码不用重装：

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-x-search" "E:\工作2\dsh-x-search"
```

## 注册进 profile

编辑 `profiles/desktop/package.json`，**两处都要加，缺一不加载**：

```json
"dependencies":        { "dsh-x-search": "link:E:/工作2/dsh-x-search" }
"dsh.profile.bundles": [ "dsh-x-search" ]
```

改完**重启 DSH Desktop** 才生效。

## 依赖解析

插件 `import` 了 DSH 内部包 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。

正常情况下 Node 会从 `profiles/desktop/node_modules/@deepseek-ai/` 解析上去。如果启动时报
`Cannot find package '@deepseek-ai/dsh-tools'`，给插件目录建两个 junction 指向已装好的那份：

```bat
cd /d "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-x-search"
mkdir node_modules\@deepseek-ai
mklink /J node_modules\@deepseek-ai\dsh-tools    "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-tools"
mklink /J node_modules\@deepseek-ai\schemastery "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
```

这两个 junction 是**本机路径**，仓库里不带。

## 用之前：凭证

插件需要 X 的 `auth_token` 与 `ct0`（浏览器已登录就有）。两种给法：

1. 环境变量 `X_AUTH_TOKEN` / `X_CT0`
2. 写进 `~/.dsh/x-search.json`：

```json
{ "authToken": "…40 位十六进制…", "ct0": "…160 位十六进制…" }
```

从浏览器抄：登录 x.com → F12 → Application → Storage → Cookies → `https://x.com` → 找 `auth_token` 与 `ct0`。

`ct0` 会随会话轮换，过期就重新抄一次（`x_auth` 会告诉你还行不行）。

## 验证装好了

重启后在 DSH 里调：

```
x_auth
```

看到 `ok: true` 且 `operations` 有几十条，就说明通了。再试：

```
x_search(query="kiro", limit=5)
x_user(user="@elonmusk")
```

## 包里的东西

```
dsh-x-search/
├── package.json          插件声明，bundle 入口在 dsh.bundle.patch
├── cordis.patch.yml      加载条目
├── README.md             用法与实现要点
├── INSTALL.md            本文件
├── lib/
│   ├── index.js          4 个工具的定义与注册
│   ├── xapi.mjs          GraphQL 客户端（cookie / shell 缓存 / 操作表自愈 / 推文归一化）
│   ├── txid.mjs          x-client-transaction-id 生成（零依赖）
│   ├── operations.json   operationName → queryId（自动刷新）
│   └── features.json     各操作的 feature flags
├── scripts/check.mjs     离线自检
├── test/
│   ├── unit.mjs          纯函数单测 39 项
│   └── fixtures/         真实 SearchTimeline 响应样本
└── tools/                开发期脚本（cli.mjs 可直接当命令行用，不进包）
```

## 自测

```bash
node scripts/check.mjs    # 结构 / 语法 / 工具数 / 无明文凭证 / 单测
node test/unit.mjs        # 纯函数，不联网
node tools/cli.mjs whoami # 真实链路（需要凭证与网络，必要时设 HTTPS_PROXY）
```

## 安全

`auth_token` 等同账号登录态，插件只在内存里用，不打日志、不落盘。
唯一的落盘是 `lib/operations.json`（queryId 缓存），里面没有凭证。
