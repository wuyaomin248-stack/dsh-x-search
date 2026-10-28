# dsh-x-search

DeepSeek Harness 的 X（twitter）搜索与读取工具，**4 个只读工具**。
不需要浏览器、不需要开页面 —— 插件自己算 `x-client-transaction-id`，直接打 X 的 GraphQL。

## 工具

| 工具 | 干什么 |
|---|---|
| `x_auth` | 自检：auth_token / ct0 能不能过 GraphQL、txid 能不能生成、operation 表里有多少 queryId。也能写入新凭证。 |
| `x_search` | 搜推文。支持 X 高级搜索语法，也支持 `from` / `since` / `until` / `minFav` / `media` / `replies` 便捷参数；`product` 可填 `Latest` / `Top` / `Media`；自动去重、可多页。 |
| `x_user` | 查账号资料（昵称、简介、粉丝/关注/推文数、认证、注册时间）。`kind` 可选 `tweets`（默认）/ `media` / `replies` / `originals`，一条时间线对应一个 GraphQL 操作。 |
| `x_thread` | 拉一条推文下面的对话（主贴 + 回复/引用），可多页翻。 |

## 典型用法

```
x_search(query="kiro launch", product="Top", limit=10)
x_search(query="", from="awscloud", since="2026-10-01", minFav=50, pages=3)
x_search(query="kiro", product="Media")                      # 只要带图带视频的
x_user(user="@elonmusk")                                     # 只看资料
x_user(user="@elonmusk", kind="media", limit=20)             # 他发过的图
x_user(user="@elonmusk", kind="originals")                   # 原创，滤掉转推
x_thread(tweetId="https://x.com/elonmusk/status/1234567890", onlyReplies=true, pages=3)
x_auth()                                                     # 搜不到东西时先跑这个
```

返回的每条推文长这样（`text` 是全文，长推走 `note_tweet`）：

```json
{
  "id": "2115364148263649557",
  "user": "infinterenders",
  "name": "…",
  "time": "2026-10-28T08:44:12Z",
  "text": "Is this the end of Kiro too? …",
  "fav": 0, "rt": 0, "reply": 0, "views": 10,
  "url": "https://x.com/infinterenders/status/2115364148263649557",
  "media": ["https://pbs.twimg.com/..."],
  "lang": "en"
}
```

`nextCursor` 原样传给下一次调用的 `cursor` 就能接着翻；`pages` 参数会在内部连续翻几页再去重合并。

## 凭证

优先级：`X_AUTH_TOKEN` / `X_CT0` 环境变量 > `~/.dsh/x-search.json`。

```json
{ "authToken": "…40 位十六进制…", "ct0": "…160 位十六进制…" }
```

从浏览器拿：登录 x.com → F12 → Application → Cookies → `https://x.com` → 抄 `auth_token` 与 `ct0`。
或者直接用 `x_auth(authToken="…", ct0="…")` 写进去。

`ct0` 会随会话轮换，`auth_token` 有效期很长。报 403/404 且 `x_auth` 说不可用时，重新抄一次即可。

## 实现要点

`x-client-transaction-id` 是 X 给每个 GraphQL 请求加的防伪头，实测（见 `lib/txid.mjs` 注释）：
同一 URL 复用抓到的值能过、去掉就 404、随机值 404、换个搜索词复用旧值也 404。
所以它必须每次现算。原料全在 x.com 首页 HTML 里（未登录也有）：

1. `<meta name="twitter-site-verification">` → 48 字节 key
2. webpack runtime 里的 `ondemand.s.<hash>a.js` → 里面藏着行号与字节索引
3. 4 个 `<svg id="loading-x-anim-N">` 的第 2 条 path → 动画关键帧

算出来的串长 94 字符，固定 70 字节（key 48 + 时间 4 + 哈希 16 + 常量 1 + 随机 1），末位异或一个随机数防重放。

`queryId` 每次发版都会变，所以插件启动后第一次调用会去 `main.<hash>a.js` 里正则提取 `operationName → queryId` 并缓存到 `lib/operations.json`（当前 104 条）。`features` 只有 `SearchTimeline` 有官方值，其他操作用「同一套键名全 true」兜底，实测 `UserByScreenName` / `UserTweets` / `UserMedia` / `UserRepliesTimeline` / `UserOriginalsTimeline` / `TweetDetail` 都吃得下。

**自愈**：404 说明 `queryId` 随发版变了（或 txid 原料过期），这时 `_shell` 与 `_opsAt` 一起清掉，下一次调用自动重新提取；403 说明 cookie 过期，只清 shell。错误信息里会带上这句提示。
txid 原料会落盘到 `~/.dsh/x-search-shell.json`（30 分钟 TTL），冷启动省掉两次 HTTP；原料复用是安全的，因为时间戳参与哈希，同一份原料每次算出的 txid 都不同。

## 验证

```bash
node scripts/check.mjs     # 离线自检：结构/语法/工具数/无明文凭证/单测
node test/unit.mjs         # 纯函数单测（语法拼接、真实响应解析、txid 结构、磁盘缓存契约）
node tools/cli.mjs whoami
node tools/cli.mjs search "kiro" --product Media --count 5
node tools/cli.mjs user elonmusk
node tools/cli.mjs tweets elonmusk --kind media --count 5
node tools/cli.mjs thread 1234567890 --pages 3
```

CLI 与工具共用 `lib/xapi.mjs`，所以 CLI 通了工具就通。需要代理时先 `$env:HTTPS_PROXY='http://127.0.0.1:7890'`。

## 只读边界

只发查询类 GraphQL：`SearchTimeline` / `UserByScreenName` / `UserTweets` / `UserMedia` / `UserRepliesTimeline` / `UserOriginalsTimeline` / `TweetDetail`，加一个 `ViewerBadgeCounts` 自检。
没有发推、点赞、关注、改资料、DM 的代码路径。cookie 只在内存里，不打日志；唯一的落盘是 `lib/operations.json`（queryId 缓存）和 `~/.dsh/x-search-shell.json`（txid 原料），两者都不含凭证。

## 许可

MIT。txid 算法移植自 npm `x-client-transaction-id` 0.3.2（MIT, github.com/Lqm1/x-client-transaction-id），去掉了它的 linkedom 依赖。
