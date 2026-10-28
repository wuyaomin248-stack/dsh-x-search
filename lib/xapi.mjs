// X（twitter）GraphQL 客户端：cookie + 自动 txid + 操作表自愈，纯 Node 零依赖。
// 数据流：拉 x.com 首页拿 site-verification 与动画帧 → 算 x-client-transaction-id → GET /i/api/graphql/<queryId>/<op>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepare, generate } from './txid.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const SHELL_TTL = 10 * 60 * 1000;       // 内存里的 txid 原料缓存
const SHELL_DISK_TTL = 30 * 60 * 1000;  // 落盘缓存：冷启动省掉两次 HTTP；真过期了由 404 自愈兜底
const OPS_TTL = 60 * 60 * 1000;

// 读 JSON 一律先剥 BOM：PowerShell 的 Set-Content -Encoding utf8 会写 BOM，
// 直接 JSON.parse 会抛 "Unexpected token in JSON"，然后凭证就被当成不存在。
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const loadJson = (p, fallback) => readJson(p) ?? fallback;

const OPERATIONS_FILE = path.join(HERE, 'operations.json');
const FEATURES_FILE = path.join(HERE, 'features.json');
const SHELL_FILE = path.join(os.homedir(), '.dsh', 'x-search-shell.json');
const CRED_FILE = path.join(os.homedir(), '.dsh', 'x-search.json');

/** 用户时间线的四种视图 → GraphQL 操作名（四个都实测可用，features 全 true 兜底吃得下）。 */
const TIMELINE_OPS = {
  tweets: 'UserTweets',
  media: 'UserMedia',
  replies: 'UserRepliesTimeline',
  originals: 'UserOriginalsTimeline',
};

/** 凭证优先级：环境变量 > ~/.dsh/x-search.json */
export function loadCredentials(overrides = {}) {
  const file = readJson(CRED_FILE) || {};
  const authToken = overrides.authToken || process.env.X_AUTH_TOKEN || file.authToken || '';
  const ct0 = overrides.ct0 || process.env.X_CT0 || file.ct0 || '';
  return { authToken, ct0, source: overrides.authToken || process.env.X_AUTH_TOKEN ? 'env' : (file.authToken ? CRED_FILE : null) };
}

export function saveCredentials({ authToken, ct0 }) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify({ authToken, ct0, savedAt: new Date().toISOString() }, null, 1));
  return CRED_FILE;
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const s = (v) => (v == null ? '' : String(v));

/** 一条推文 → 扁平记录。字段名短是给模型省 token，工具层会再整理。 */
function normalizeTweet(r) {
  const u = r.core?.user_results?.result || {};
  const l = r.legacy || {};
  const uc = u.core || {};
  const ul = u.legacy || {};
  const note = r.note_tweet?.note_tweet_results?.result?.text;
  const text = note || l.full_text || '';
  const media = (l.extended_entities?.media || l.entities?.media || []).map((m) => ({
    type: m.type || '',
    url: m.media_url_https || m.media_url || '',
  }));
  const links = [];
  for (const e of l.entities?.urls || []) {
    const ex = e.expanded_url || '';
    if (ex && !/^https?:\/\/t\.co\//.test(ex) && !links.includes(ex)) links.push(ex);
  }
  const user = uc.screen_name || ul.screen_name || '';
  const id = s(r.rest_id);
  return {
    id,
    user,
    name: uc.name || ul.name || '',
    text,
    createdAt: l.created_at || '',
    ts: Math.floor(Date.parse(l.created_at || '') / 1000) || 0,
    lang: s(l.lang),
    fav: n(l.favorite_count),
    rt: n(l.retweet_count),
    reply: n(l.reply_count),
    quote: n(l.quote_count),
    bookmark: n(l.bookmark_count),
    views: n(r.views?.count),
    media,
    links,
    replyTo: s(l.in_reply_to_screen_name) || null,
    isQuote: !!l.is_quote_status,
    isRT: !!l.retweeted_status_result,
    url: user && id ? `https://x.com/${user}/status/${id}` : '',
    verified: !!u.is_blue_verified,
  };
}

/** 不写死路径：任何带 rest_id + legacy + 作者 的节点都当推文。 */
function walkTweets(node, out, budget = { n: 0 }) {
  if (!node || typeof node !== 'object' || budget.n > 300000) return;
  budget.n++;
  if (Array.isArray(node)) { for (const v of node) walkTweets(v, out, budget); return; }
  let t = node;
  if (t.__typename === 'TweetWithVisibilityResults' && t.tweet) t = t.tweet;
  if (t.rest_id && t.legacy && t.core?.user_results?.result) { out.push(normalizeTweet(t)); return; }
  for (const k in node) walkTweets(node[k], out, budget);
}

function bottomCursor(node) {
  let out = null;
  const seen = { n: 0 };
  const visit = (x) => {
    if (!x || typeof x !== 'object' || seen.n > 200000 || out) return;
    seen.n++;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (x.cursorType === 'Bottom' && x.value) { out = s(x.value); return; }
    for (const k in x) visit(x[k]);
  };
  visit(node);
  return out;
}

/** 把便捷参数拼成 X 高级搜索语法（服务端过滤，比本地过滤省流量也更准）。 */
export function buildQuery({ query = '', from, since, until, minFav, media, replies } = {}) {
  const parts = [String(query || '').trim()];
  if (from) parts.push(`from:${String(from).replace(/^@/, '')}`);
  if (since) parts.push(`since:${since}`);
  if (until) parts.push(`until:${until}`);
  if (minFav) parts.push(`min_faves:${Number(minFav)}`);
  if (media) parts.push('filter:media');
  if (replies === 'exclude') parts.push('-filter:replies');
  return parts.filter(Boolean).join(' ');
}

export class XClient {
  constructor({ authToken, ct0, lang = 'zh-cn' } = {}) {
    const c = loadCredentials({ authToken, ct0 });
    if (!c.authToken) throw new Error('没有 X 的 auth_token：设环境变量 X_AUTH_TOKEN，或写到 ~/.dsh/x-search.json');
    if (!c.ct0) throw new Error('没有 ct0（CSRF token）：设 X_CT0，或写到 ~/.dsh/x-search.json');
    this.authToken = c.authToken;
    this.ct0 = c.ct0;
    this.credSource = c.source;
    this.lang = lang;
    this._shell = null;
    this._shellAt = 0;
    // 冷启动先吃落盘的 txid 原料，省掉「拉首页 + 拉 ondemand.s」两次 HTTP
    const disk = readJson(SHELL_FILE);
    if (disk && disk.shell && Date.now() - (disk.at || 0) < SHELL_DISK_TTL) {
      this._shell = disk.shell;
      this._shellAt = disk.at;
      this._shellFromDisk = true;
    }
    this._ops = loadJson(OPERATIONS_FILE, {});
    this._opsAt = fs.existsSync(OPERATIONS_FILE) ? fs.statSync(OPERATIONS_FILE).mtimeMs : 0;
    this._features = loadJson(FEATURES_FILE, {});
    this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0}; lang=${lang}`;
  }

  async text(url) {
    const r = await fetch(url, {
      headers: {
        cookie: this.cookieHeader,
        'user-agent': UA,
        accept: url.endsWith('.js') ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.text();
  }

  async shell(force = false) {
    if (!force && this._shell && Date.now() - this._shellAt < SHELL_TTL) return this._shell;
    const html = await this.text('https://x.com/');
    this._shell = await prepare(html, (u) => this.text(u));
    this._shellAt = Date.now();
    this._shellFromDisk = false;
    try {
      fs.mkdirSync(path.dirname(SHELL_FILE), { recursive: true });
      fs.writeFileSync(SHELL_FILE, JSON.stringify({ at: this._shellAt, shell: this._shell }));
    } catch {}
    return this._shell;
  }

  /** 落盘的 shell 过期了才重新拉；没过期就继续用（txid 每次都重算，原料复用是安全的）。 */
  async ensureShell() {
    if (!this._shell || Date.now() - this._shellAt > SHELL_TTL) {
      if (Date.now() - this._shellAt > SHELL_DISK_TTL) return this.shell(true);
      return this.shell();
    }
    return this._shell;
  }

  /** 从 main bundle 里刷新 operationName → queryId（X 每次发版会变）。 */
  async refreshOperations(force = false) {
    if (!force && Date.now() - this._opsAt < OPS_TTL && Object.keys(this._ops).length) return this._ops;
    const html = await this.text('https://x.com/');
    const main = /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[^"]+)"/.exec(html)?.[1];
    if (!main) throw new Error('首页里没找到 main bundle');
    const js = await this.text(main);
    const pairs = {};
    for (const m of js.matchAll(/queryId:"([A-Za-z0-9_-]{10,})"[^}]{0,120}?operationName:"([A-Za-z]+)"/g)) pairs[m[2]] = m[1];
    for (const m of js.matchAll(/operationName:"([A-Za-z]+)"[^}]{0,120}?queryId:"([A-Za-z0-9_-]{10,})"/g)) if (!pairs[m[1]]) pairs[m[1]] = m[2];
    if (!Object.keys(pairs).length) throw new Error('bundle 里没提取到 queryId/operationName 对');
    this._ops = { ...this._ops, ...pairs };
    this._opsAt = Date.now();
    try { fs.writeFileSync(OPERATIONS_FILE, JSON.stringify(this._ops, null, 1)); } catch {}
    return this._ops;
  }

  /** features：官方默认表里有的用官方值；没有的用 SearchTimeline 的键名全 true 兜底。 */
  featuresFor(op) {
    const exact = this._features[op];
    if (exact) return exact;
    const base = this._features.SearchTimeline || {};
    return Object.fromEntries(Object.keys(base).map((k) => [k, true]));
  }

  async queryIdFor(op) {
    const stale = Date.now() - this._opsAt > OPS_TTL;
    if (!this._ops[op] || stale) await this.refreshOperations(true);
    const id = this._ops[op];
    if (!id) throw new Error(`operation 表里没有 ${op}（可能 X 把它改名了）`);
    return id;
  }

  /** 底层 GraphQL GET。返回 {status, json, text} 不抛业务错，让上层判断。 */
  async graphql(op, variables, { features, method = 'GET' } = {}) {
    const queryId = await this.queryIdFor(op);
    const apiPath = `/i/api/graphql/${queryId}/${op}`;
    const ctx = await this.ensureShell();
    const txid = generate(ctx, method, apiPath);
    const feat = features || this.featuresFor(op);
    const url = `https://x.com${apiPath}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(feat))}`;
    const r = await fetch(url, {
      method,
      headers: {
        cookie: this.cookieHeader,
        authorization: 'Bearer ' + BEARER,
        'x-csrf-token': this.ct0,
        'x-client-transaction-id': txid,
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': this.lang,
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/json',
        'user-agent': UA,
        referer: 'https://x.com/',
      },
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (r.status === 403) {
      // cookie 过期（ct0 轮换最常见）
      this._shell = null;
    } else if (r.status === 404) {
      // 404 = queryId 随发版变了（或 txid 过期）。两者都要清，否则接下来一小时都在撞旧值。
      this._shell = null;
      this._opsAt = 0;
    }
    return { status: r.status, json, text, op, queryId, txidLen: txid.length };
  }

  unwrap(res) {
    if (res.status === 200 && res.json?.data) return res.json;
    const errs = res.json?.errors?.map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`).join(' | ');
    const hint = res.status === 404 ? ' · 已清掉 queryId/txid 缓存，重试一次会自动重新提取'
      : res.status === 403 ? ' · cookie 可能过期，跑 x_auth 重新写入'
      : '';
    throw new Error(`X ${res.op} HTTP ${res.status}${hint}${errs ? ' · ' + errs : ''}${res.text && !res.json ? ' · ' + res.text.slice(0, 180) : ''}`);
  }

  async search(q, { product = 'Latest', count = 20, cursor } = {}) {
    const variables = {
      rawQuery: q,
      count: Math.min(Math.max(count, 10), 100),
      querySource: '',
      product: ['Latest', 'Top', 'Media'].includes(product) ? product : 'Latest',
      withGrokTranslatedBio: false,
      withQuickPromoteEligibilityTweetFields: false,
    };
    if (cursor) variables.cursor = cursor;
    const res = await this.graphql('SearchTimeline', variables);
    const json = this.unwrap(res);
    const tweets = [];
    walkTweets(json, tweets);
    return { tweets, nextCursor: bottomCursor(json), op: res.op };
  }

  async userByScreenName(screenName) {
    const res = await this.graphql('UserByScreenName', {
      screen_name: screenName.replace(/^@/, ''),
      withGrokTranslatedBio: false,
    });
    const json = this.unwrap(res);
    const r = json.data?.user?.result;
    if (!r) throw new Error(`没找到用户 @${screenName}`);
    const u = r.core || {};
    const lg = r.legacy || {};
    return {
      id: r.rest_id,
      user: u.screen_name || lg.screen_name,
      name: u.name || lg.name,
      bio: lg.description || '',
      location: r.location?.location || lg.location || '',
      followers: r.relationship_counts?.followers ?? lg.followers_count ?? 0,
      following: r.relationship_counts?.following ?? lg.friends_count ?? 0,
      tweets: r.tweet_counts?.tweets ?? lg.statuses_count ?? 0,
      verified: !!r.is_blue_verified,
      createdAt: u.created_at || lg.created_at || '',
      url: `https://x.com/${u.screen_name || lg.screen_name}`,
    };
  }

  /** 用户时间线：kind = tweets（默认）/ media / replies / originals，对应四个不同的 GraphQL 操作。 */
  async userTweets(userId, { kind = 'tweets', count = 20, cursor } = {}) {
    const op = TIMELINE_OPS[kind] || TIMELINE_OPS.tweets;
    const variables = {
      userId,
      count: Math.min(Math.max(count, 5), 100),
      includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;
    const res = await this.graphql(op, variables);
    const json = this.unwrap(res);
    const tweets = [];
    walkTweets(json, tweets);
    return { tweets, nextCursor: bottomCursor(json), op: res.op };
  }

  async thread(tweetId, { cursor } = {}) {
    const variables = {
      focalTweetId: String(tweetId),
      with_rux_injections: false,
      rankingMode: 'Relevance',
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: true,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;
    const res = await this.graphql('TweetDetail', variables);
    const json = this.unwrap(res);
    const tweets = [];
    walkTweets(json, tweets);
    return { tweets, nextCursor: bottomCursor(json), op: res.op };
  }

  /** 轻量自检：cookie 有效？txid 能过？ */
  async whoami() {
    const res = await this.graphql('ViewerBadgeCounts', {});
    if (res.status !== 200) {
      const b = await this.graphql('UserByScreenName', { screen_name: 'x', withGrokTranslatedBio: false });
      return { ok: b.status === 200, probe: 'UserByScreenName', status: b.status };
    }
    return { ok: true, probe: 'ViewerBadgeCounts', status: 200 };
  }
}

export { normalizeTweet, walkTweets };
