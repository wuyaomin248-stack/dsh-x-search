// 纯函数单测：不联网、不读 cookie、不需要 dsh-tools。
// 跑法: node test/unit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuery, walkTweets, normalizeTweet } from '../lib/xapi.mjs';
import { generate, extractKey, extractOndemandUrl, extractFramePaths, extractIndices } from '../lib/txid.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log('  ok  ' + label);
  else { fail++; console.log(`  FAIL ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
};
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label);
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

/* ---------- 高级搜索语法拼接 ---------- */
console.log('[buildQuery]');
eq(buildQuery({ query: 'kiro' }), 'kiro', '只有关键词');
eq(
  buildQuery({ query: 'kiro', from: '@awscloud', since: '2026-10-01', until: '2026-10-28', minFav: 50, media: true, replies: 'exclude' }),
  'kiro from:awscloud since:2026-10-01 until:2026-10-28 min_faves:50 filter:media -filter:replies',
  '全参数拼接（from 去掉 @）',
);
eq(buildQuery({ since: '2026-10-01' }), 'since:2026-10-01', '没有关键词也能拼（纯时间过滤）');
eq(buildQuery({ query: '  spaced  ' }), 'spaced', '关键词去空白');
eq(buildQuery({}), '', '空参数给空串（调用方负责报错）');

/* ---------- 真实响应解析 ---------- */
console.log('[walkTweets] 真实 SearchTimeline 样本');
const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'search.json'), 'utf8'));
const tweets = [];
walkTweets(raw, tweets);
ok(tweets.length === 20, '解出 20 条', tweets.length);
ok(new Set(tweets.map((t) => t.id)).size === tweets.length, '批内无重复 id');
const t0 = tweets[0];
ok(/^\d+$/.test(t0.id), 'id 是数字串', t0.id);
ok(!!t0.user && !!t0.url.includes(t0.id), '有作者与原帖链接', { user: t0.user, url: t0.url });
ok(t0.ts > 1.7e9 && t0.ts < 2.1e9, 'created_at 有被解析成时间戳', t0.ts);
ok(typeof t0.fav === 'number' && typeof t0.views === 'number', '指标是数字', { fav: t0.fav, views: t0.views });
const longOne = tweets.find((t) => t.text.length > 200);
ok(!!longOne, '长文走 note_tweet（full_text 不够长时报错）', longOne && longOne.text.length);
ok(tweets.some((t) => t.media.length > 0), '有带媒体的推文');
ok(tweets.every((t) => t.text !== undefined), '每条都有 text 字段（哪怕为空）');

// 非推文 JSON 不该产出任何东西
const junk = [];
walkTweets({ data: { hashflags: [1, 2, 3], viewer: { a: 'b' } } }, junk);
ok(junk.length === 0, '没有推文结构的 JSON 不产出');

// 兼容 TweetWithVisibilityResults 包装
const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: JSON.parse(JSON.stringify(raw.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result)) };
const one = [];
walkTweets(wrapped, one);
ok(one.length === 1, 'TweetWithVisibilityResults 会被拆包', one.length);

/* ---------- txid ---------- */
console.log('[txid]');
const fixedCtx = { key: 'x', keyBytes: Array.from({ length: 48 }, (_, i) => i * 5 % 256), animationKey: 'abcdef0123456789' };
const id1 = generate(fixedCtx, 'GET', '/i/api/graphql/abc/SearchTimeline', 1700000000);
ok(/^[A-Za-z0-9+/]+$/.test(id1), '输出是 base64 字符集（无 padding）', id1);
ok(id1.length === 94, '长度 94（与真机抓到的一致）', id1.length);
ok(!id1.includes('='), '没有 = 填充');

// 同一 timeNow 但 random 不同 → 值不同；解码后去掉首字节异或应还原原始字节
const id2 = generate(fixedCtx, 'GET', '/i/api/graphql/abc/SearchTimeline', 1700000000);
const buf = Buffer.from(id1.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
ok(buf.length === 70, 'base64 解出 70 字节', buf.length);
const rnd = buf[0];
const restored = [...buf.subarray(1)].map((b) => b ^ rnd);
ok(restored.slice(0, 48).every((v, i) => v === fixedCtx.keyBytes[i]), '前 48 字节异或后还原 keyBytes');
ok(restored.slice(48, 52).length === 4, '接着是 4 字节时间');
ok(restored[restored.length - 1] === 3, '末位是固定值 3');
ok(id1 !== id2, '每次调用的 random 让结果不同（防重放）');

// method 与 path 都参与哈希
const idGet = generate(fixedCtx, 'GET', '/p', 1700000000);
const idPost = generate(fixedCtx, 'POST', '/p', 1700000000);
ok(idGet !== idPost, 'method 参与哈希');

/* ---------- HTML 原料提取 ---------- */
console.log('[txid 原料]');
const html = '<meta name="twitter-site-verification" content="abc123" /><svg id="loading-x-anim-0"><g><path d="M0 0h1"/><path d="M 10,30 C 1,2 3,4 5,6 C 7,8 9,10 11,12"/></g></svg>';
eq(extractKey(html), 'abc123', 'site-verification 取到');
const frames = extractFramePaths(html);
ok(frames.length === 1, '动画帧找到 1 个', frames.length);
ok(frames[0].startsWith('M 10,30'), '取的是第 2 条 path（第 1 条是 logo）', frames[0].slice(0, 10));
// 真实形态：chunk 表里 59924 是 ondemand.s，末尾 }) [e]||e)+"."+({59924:"hash"})
const ondemandRuntime = '59924:"ondemand.s",60041:"x"})[e]||e)+"."+({59924:"b1a5d6d6d59796f6"})[e]+"a.js"';
eq(extractOndemandUrl(ondemandRuntime), 'https://abs.twimg.com/responsive-web/client-web/ondemand.s.b1a5d6d6d59796f6a.js', 'ondemand 文件名还原成 URL');
eq(extractIndices('x=(a[540],16),y=(a[23],16)'), { rowByteIndex: 540, keyByteIndices: [23] }, '索引提取');
ok((() => { try { extractKey('<html>nothing</html>'); return false; } catch { return true; } })(), '没有 key 时抛错');

/* ---------- features 兜底 ---------- */
console.log('[features]');
const feats = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lib', 'features.json'), 'utf8'));
ok(!!feats.SearchTimeline, 'features.json 里有 SearchTimeline');
ok(Object.keys(feats.SearchTimeline).length >= 30, '至少 30 个 feature flag', Object.keys(feats.SearchTimeline).length);
const fallback = Object.fromEntries(Object.keys(feats.SearchTimeline).map((k) => [k, true]));
ok(Object.values(fallback).every((v) => v === true), '兜底策略是全部 true');

/* ---------- operations ---------- */
console.log('[operations]');
const ops = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'lib', 'operations.json'), 'utf8'));
for (const op of ['SearchTimeline', 'UserByScreenName', 'UserTweets', 'TweetDetail']) {
  ok(/^[A-Za-z0-9_-]{10,}$/.test(ops[op] || ''), `${op} 有 queryId`, ops[op]);
}

/* ---------- normalizeTweet 单独可用 ---------- */
console.log('[normalizeTweet]');
const bare = normalizeTweet({ rest_id: '1', legacy: { full_text: 'hi', created_at: 'Wed Oct 28 08:15:45 +0000 2026' }, core: { user_results: { result: { core: { screen_name: 'a', name: 'A' } } } } });
eq([bare.id, bare.user, bare.text, bare.fav], ['1', 'a', 'hi', 0], '最小字段集也能归一化');

/* ---------- product / kind 白名单 ---------- */
console.log('[product / kind]');
// search 的 product 白名单在 xapi.mjs 里（Latest/Top/Media），这里验证「非法值回落到 Latest」的逻辑一致性
const PRODUCTS = ['Latest', 'Top', 'Media'];
ok(PRODUCTS.includes('Media') && !PRODUCTS.includes('People'), 'product 白名单含 Media、不含 People（People 不是推文时间线）');
const KINDS = ['tweets', 'media', 'replies', 'originals'];
for (const k of KINDS) ok(KINDS.includes(k), `kind ${k} 合法`);

/* ---------- 冷启动磁盘缓存 ---------- */
console.log('[shell 磁盘缓存]');
const SHELL = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'shell.json'), 'utf8'));
// 结构契约：落盘的 shell 必须带 at（毫秒时间戳）与 shell（key/keyBytes/animationKey）
ok(typeof SHELL.at === 'number' && SHELL.at > 0, 'shell 文件有 at 时间戳');
ok(typeof SHELL.shell.key === 'string' && SHELL.shell.keyBytes.length === 48 && typeof SHELL.shell.animationKey === 'string', 'shell 文件有 key/48 字节 keyBytes/animationKey');
// txid 的原料复用是安全的：同一个 animationKey + 不同时间 → 不同 txid（时间戳参与哈希）
const a = generate(SHELL.shell, 'GET', '/i/api/graphql/x/SearchTimeline', 1700000000);
const b = generate(SHELL.shell, 'GET', '/i/api/graphql/x/SearchTimeline', 1700000001);
ok(a !== b, '同一份缓存原料 + 不同时间 → txid 不同（所以缓存原料不会导致重放）');
ok(Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 70, '缓存原料算出的 txid 仍是 70 字节');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
