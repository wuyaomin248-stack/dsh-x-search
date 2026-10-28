// 验证「纯 Node 生成的 x-client-transaction-id」能否让 SearchTimeline 返回 200。
// 用法: node tools/verify-txid.mjs [关键词]
import fs from 'node:fs';
import { prepare, generate } from '../lib/txid.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const q = process.argv[2] || 'kiro';

const jar = JSON.parse(fs.readFileSync('E:/工作2/.tmp/x-cookies.json', 'utf8'));
const cookies = jar.cookies.filter((c) => /(^|\.)x\.com$/.test(c.domain));
const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
const ct0 = (cookies.find((c) => c.name === 'ct0') || {}).value;
if (!ct0) throw new Error('cookie 里没有 ct0，没法过 CSRF');

// 样本里拿默认 queryId 与 features（会随发版变，插件里做了自动提取兜底）
const idx = JSON.parse(fs.readFileSync('E:/工作2/x-search-ext/samples/index.json', 'utf8'));
const tpl = idx.find((x) => x.op === 'SearchTimeline');
const u0 = new URL(tpl.url);
const queryId = u0.pathname.split('/')[4];
const features = u0.searchParams.get('features');
const tplVars = JSON.parse(u0.searchParams.get('variables'));

const get = (url, extra = {}) => fetch(url, { headers: { cookie, 'user-agent': UA, ...extra } });

const t0 = Date.now();
const home = await (await get('https://x.com/')).text();
console.log(`[home] ${Date.now() - t0}ms bytes=${home.length} title=${(/<title[^>]*>([^<]+)/.exec(home) || [])[1]}`);

const t1 = Date.now();
const ctx = await prepare(home, async (url) => {
  const r = await get(url);
  if (!r.ok) throw new Error('ondemand.s ' + r.status);
  return r.text();
});
console.log(`[prepare] ${Date.now() - t1}ms key=${ctx.key.slice(0, 12)}… animationKey=${ctx.animationKey.slice(0, 24)}…`);

const path = `/i/api/graphql/${queryId}/SearchTimeline`;
const variables = JSON.stringify({ ...tplVars, rawQuery: q, product: 'Latest' });
const url = `https://x.com${path}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;

const txid = generate(ctx, 'GET', path);
console.log(`[txid] len=${txid.length} ${txid.slice(0, 32)}…`);

const res = await get(url, {
  authorization: 'Bearer ' + BEARER,
  'x-csrf-token': ct0,
  'x-client-transaction-id': txid,
  'x-twitter-active-user': 'yes',
  'x-twitter-client-language': 'zh-cn',
  'x-twitter-auth-type': 'OAuth2Session',
  'content-type': 'application/json',
  referer: `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
});
const body = await res.text();
console.log(`[resp] status=${res.status} bytes=${body.length}`);
if (res.status === 200) {
  const j = JSON.parse(body);
  const tl = j?.data?.search_by_raw_query?.search_timeline?.timeline;
  const ents = (tl?.instructions || []).flatMap((i) => i.entries || []);
  const items = ents.filter((e) => e.content?.entryType === 'TimelineTimelineItem');
  const cursors = ents.filter((e) => e.content?.entryType === 'TimelineTimelineCursor');
  console.log(`[ok] entries=${items.length} cursors=${cursors.map((c) => c.content.cursorType).join('/')}`);
  const tw = items.slice(0, 3).map((e) => {
    const r = e.content.itemContent.tweet_results.result;
    const t = r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
    return `@${t.core.user_results.result.core.screen_name}: ${(t.legacy.full_text || '').replace(/\n/g, ' ').slice(0, 50)}`;
  });
  tw.forEach((x) => console.log('   ', x));
} else {
  console.log('[fail]', body.slice(0, 200));
  process.exit(1);
}
