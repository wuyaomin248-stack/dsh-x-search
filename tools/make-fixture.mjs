// 把真实抓到的 SearchTimeline 响应脱敏成可公开的测试样本。
// 策略是白名单：只保留解析器真正依赖的字符串字段（__typename 之类的结构标记、
// 作者 handle、正文、时间、语言、媒体 URL），其余所有字符串一律换成占位，
// 这样 hashtag / bio / 转推正文里夹带的原账号名不会漏出去。
// 用法: node tools/make-fixture.mjs [源文件]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, '.tmp', 'search-real.json');
const OUT = path.join(ROOT, 'test', 'fixtures', 'search.json');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const idMap = new Map();
let idSeq = 0;
const remapId = (v) => {
  if (!idMap.has(v)) idMap.set(v, String(2000000000000000000n + BigInt(++idSeq)));
  return idMap.get(v);
};
const userMap = new Map();
let userSeq = 0;
const remapUser = (v) => {
  if (!userMap.has(v)) userMap.set(v, `demo_user_${++userSeq}`);
  return userMap.get(v);
};
const nameMap = new Map();
let nameSeq = 0;
const remapName = (v) => {
  if (!nameMap.has(v)) nameMap.set(v, `Demo User ${++nameSeq}`);
  return nameMap.get(v);
};

const FIXED_DATE = 'Wed Oct 28 08:15:45 +0000 2026';
const PLACEHOLDER = '（脱敏样本：占位推文内容，只用于验证解析器字段提取。）';
const fillText = (orig) => {
  const want = Math.max((orig || '').length, PLACEHOLDER.length);
  let s = PLACEHOLDER;
  while (s.length < want) s += PLACEHOLDER;
  return s.slice(0, want);
};

// 解析器依赖的结构标记 / 枚举值：必须原样保留，否则 walkTweets 认不出推文
const KEEP_ENUM = new Set([
  '__typename', 'itemType', 'entryType', 'cursorType', 'type', 'tweetDisplayType',
  'itemType', 'cursorType', 'timelineType', 'displayType', 'mediaType', 'resize',
]);

const COUNT_FIELDS = {
  favorite_count: 12, retweet_count: 7, reply_count: 3, quote_count: 1, bookmark_count: 0,
  followers_count: 1000, friends_count: 500, statuses_count: 200, listed_count: 10,
  media_count: 5, favourites_count: 4, fast_followers_count: 1,
};

function walk(node) {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    // 结构标记：原值保留
    if (KEEP_ENUM.has(k) && typeof v === 'string') { out[k] = v; continue; }

    // id 类
    if (['rest_id', 'id_str', 'conversation_id_str', 'user_id_str', 'in_reply_to_status_id_str',
      'in_reply_to_user_id_str', 'id'].includes(k) && typeof v === 'string' && /^\d{3,}$/.test(v)) {
      out[k] = remapId(v);
      continue;
    }
    // 账号 / 昵称
    if (['screen_name', 'in_reply_to_screen_name', 'user_unique_id'].includes(k) && typeof v === 'string') {
      out[k] = remapUser(v);
      continue;
    }
    if (['name', 'full_name'].includes(k) && typeof v === 'string') {
      out[k] = remapName(v);
      continue;
    }
    // 正文（保留长度，长文断言要用）
    if (['full_text', 'text', 'display_text'].includes(k) && typeof v === 'string') {
      out[k] = fillText(v);
      continue;
    }
    // 时间 / 语言
    if (k === 'created_at' && typeof v === 'string') { out[k] = FIXED_DATE; continue; }
    if (k === 'lang' && typeof v === 'string') { out[k] = 'zh'; continue; }

    // URL 类
    if (typeof v === 'string' && /^https?:\/\//.test(v)) { out[k] = 'https://example.com/placeholder'; continue; }

    // 计数
    if (COUNT_FIELDS[k] !== undefined && (typeof v === 'number' || typeof v === 'string')) {
      out[k] = typeof v === 'string' ? String(COUNT_FIELDS[k]) : COUNT_FIELDS[k];
      continue;
    }

    // 其余字符串：不管是什么语言、什么字段，一律占位
    if (typeof v === 'string') { out[k] = 'x'; continue; }

    out[k] = walk(v);
  }
  return out;
}

const clean = walk(raw);
fs.writeFileSync(OUT, JSON.stringify(clean));

const findTweets = (node, out = [], b = { n: 0 }) => {
  if (!node || typeof node !== 'object' || b.n > 300000) return out;
  b.n++;
  if (Array.isArray(node)) { for (const v of node) findTweets(v, out, b); return out; }
  let t = node;
  if (t.__typename === 'TweetWithVisibilityResults' && t.tweet) t = t.tweet;
  if (t.rest_id && t.legacy && t.core?.user_results?.result) { out.push(t); return out; }
  for (const k in node) findTweets(node[k], out, b);
  return out;
};
const found = findTweets(clean);
const txt = fs.readFileSync(OUT, 'utf8');
console.log('[out]', OUT, (txt.length / 1024).toFixed(1) + 'KB');
console.log('[tweets]', found.length, '条');
console.log('[长文]', Math.max(...found.map((t) => (t.legacy.full_text || '').length)), '字符');
console.log('[媒体]', found.filter((t) => (t.legacy.extended_entities?.media || []).length).length, '条');
console.log('[回复]', found.filter((t) => t.legacy.in_reply_to_screen_name).length, '条');
console.log('[转推]', found.filter((t) => t.legacy.retweeted_status_result).length, '条');
const leftover = [...new Set([...txt.matchAll(/https?:\/\/(?!example\.com)[a-z0-9.-]+/gi)].map((m) => m[0]))];
console.log('[残留外链]', leftover.length ? leftover : '无');
console.log('[残留中文外的长文本]', (txt.match(/[A-Za-z]{12,}/g) || []).filter((w) => !/example|placeholder|__typename|TweetWithVisibility|TimelineTimeline|Demo|demo_user/.test(w)).slice(0, 10));
