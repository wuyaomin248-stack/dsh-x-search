/**
 * dsh-x-search · 在 X（twitter）上搜索与读取信息
 *
 * 设计取向：只读。工具只做「搜 / 看人 / 看对话 / 自检」，
 * 不发推、不点赞、不关注、不改资料。
 *
 * 实现要点：cookie 自己读、x-client-transaction-id 自己算
 * （见 lib/txid.mjs），所以不需要浏览器、不需要开页面。
 */
import { defineTool as _defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { XClient, loadCredentials, saveCredentials, walkTweets, buildQuery } from "./xapi.mjs";

export const name = "dsh-x-search";
export const inject = ["tools"];

/**
 * 输出 schema 递归放宽 additionalProperties：推文字段会随 X 发版增减，
 * 白名单式声明必然漏，宿主实调时校验直接报错。
 */
function relax(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" && schema.additionalProperties === false) schema.additionalProperties = true;
  for (const v of Object.values(schema.properties || {})) relax(v);
  relax(schema.items);
}

function defaultRender(_args, value) {
  let text;
  try { text = JSON.stringify(value ?? null, null, 1); } catch { text = String(value); }
  if (typeof text !== "string") text = String(text);
  return [{ type: "text", text }];
}

function defineTool(spec) {
  relax(spec?.output?.schema);
  if (spec.output && typeof spec.output.render !== "function") spec.output.render = defaultRender;
  return _defineTool(spec);
}

export const Config = z.object({
  /** 默认返回多少条（工具参数可覆盖）。 */
  limit: z.number().default(20),
  /** 默认翻几页（每页约 20 条）。 */
  pages: z.number().default(1),
  /** 请求 X 时用的语言。 */
  lang: z.string().default("zh-cn"),
});

/** 进程内单例：一次装好 shell 与 operation 表，后续调用省掉两次 HTTP。 */
let client = null;
let lastError = null;
function getClient(cfg) {
  if (client) return client;
  try {
    client = new XClient({ lang: cfg.lang });
    lastError = null;
  } catch (e) {
    lastError = e.message;
    throw e;
  }
  return client;
}

const ISO = (ts) => (ts ? new Date(ts * 1000).toISOString().replace(".000Z", "Z") : null);

/** 推文 → 给模型看的紧凑记录。 */
function brief(t) {
  const o = {
    id: t.id,
    user: t.user,
    name: t.name,
    time: ISO(t.ts),
    text: t.text,
    fav: t.fav,
    rt: t.rt,
    reply: t.reply,
    views: t.views,
    url: t.url,
  };
  if (t.quote) o.quote = t.quote;
  if (t.lang) o.lang = t.lang;
  if (t.replyTo) o.replyTo = t.replyTo;
  if (t.isRT) o.isRT = true;
  if (t.isQuote) o.isQuote = true;
  if (t.verified) o.verified = true;
  if (t.media?.length) o.media = t.media.map((m) => m.url);
  if (t.links?.length) o.links = t.links;
  return o;
}

const dedupe = (tweets) => {
  const seen = new Map();
  for (const t of tweets) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
};

/** 把便捷参数拼成 X 高级搜索语法 —— 实现在 xapi.mjs（那里能单测，不依赖 dsh-tools）。 */

async function paged(cfg, first, next, pages) {
  const all = [];
  let cursor;
  let last;
  for (let p = 0; p < Math.max(1, Math.min(pages || cfg.pages || 1, 10)); p++) {
    last = await (p === 0 ? first() : next(cursor));
    all.push(...last.tweets);
    cursor = last.nextCursor;
    if (!cursor) break;
  }
  return { tweets: dedupe(all), nextCursor: cursor || null };
}

export function apply(ctx, config = {}) {
  const cfg = { limit: 20, pages: 1, lang: "zh-cn", ...config };

  // 单个工具注册失败不让全部工具消失（cordis 里一处抛错整个 apply 就死）
  const register = (tool) => {
    try { return ctx.tools.register(tool); } catch (e) {
      ctx.logger?.warn?.(`[x-search] 注册 ${tool?.name} 失败: ${e?.message ?? e}`);
      return () => {};
    }
  };

  /* ---------------- 自检 / 凭证 ---------------- */
  register(defineTool({
    name: "x_auth",
    description:
      "检查 X（twitter）的登录态是否可用：验证 auth_token / ct0 能否过 GraphQL、txid 能否生成、operation 表里有多少个 queryId。也可用它写入新的 authToken/ct0（从浏览器 cookie 里抄）。搜不到东西、报 403/404 时先跑这个。",
    parameters: {
      authToken: { type: "string", description: "新的 auth_token（可省略；给了就写入 ~/.dsh/x-search.json）" },
      ct0: { type: "string", description: "新的 ct0（可省略）" },
      refresh: { type: "boolean", description: "强制刷新 shell 与 operation 表（默认 false）" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          credentialSource: { type: "string" },
          operations: { type: "number" },
          features: { type: "number" },
          probe: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    async execute({ authToken, ct0, refresh } = {}) {
      if (authToken || ct0) {
        const cur = loadCredentials();
        const saved = saveCredentials({ authToken: authToken || cur.authToken, ct0: ct0 || cur.ct0 });
        client = null;
        return { ok: true, credentialSource: saved, operations: 0, features: 0, probe: "saved", note: "凭证已写入，后续调用直接用新值" };
      }
      const c = getClient(cfg);
      if (refresh) { c._shell = null; c._opsAt = 0; await c.refreshOperations(true); }
      const r = await c.whoami();
      return {
        ok: r.ok,
        credentialSource: c.credSource || "(未知)",
        operations: Object.keys(c._ops).length,
        features: Object.keys(c.featuresFor("SearchTimeline")).length,
        probe: `${r.probe} → HTTP ${r.status}`,
        note: r.ok ? "可用" : "不可用：auth_token 或 ct0 过期，重新从浏览器 cookie 抄一次",
      };
    },
  }));

  /* ---------------- 搜索 ---------------- */
  register(defineTool({
    name: "x_search",
    description:
      "在 X（twitter）上搜推文。支持 X 高级搜索语法（from:user、since:2026-01-01、min_faves:50、filter:media、-filter:replies 等），也可用便捷参数让本工具拼接。返回推文正文、作者、时间、点赞/转推/回复/浏览数、原帖链接；自动去重、可分页。",
    parameters: {
      query: { type: "string", description: "关键词或完整高级搜索语法，如 `kiro launch from:awscloud since:2026-10-01`" },
      product: { type: "string", description: "Latest（默认，按时间）/ Top（按热度）/ Media（只要带图视频的）" },
      limit: { type: "number", description: "最多返回多少条（默认 20，上限 100）" },
      pages: { type: "number", description: "翻几页拿更多（每页约 20 条，默认 1，上限 10）" },
      from: { type: "string", description: "只要这个作者的（拼成 from:xxx）" },
      since: { type: "string", description: "起始日期 YYYY-MM-DD（拼成 since:）" },
      until: { type: "string", description: "结束日期 YYYY-MM-DD（拼成 until:，不含当天）" },
      minFav: { type: "number", description: "最少点赞数（拼成 min_faves:）" },
      media: { type: "boolean", description: "只要带媒体的（拼成 filter:media）" },
      replies: { type: "string", description: "填 exclude 排除回复（拼成 -filter:replies）" },
      cursor: { type: "string", description: "上一页返回的 nextCursor，用于继续翻" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          query: { type: "string" },
          product: { type: "string" },
          returned: { type: "number" },
          tweets: { type: "array", items: { type: "object", additionalProperties: false } },
          nextCursor: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    async execute(args = {}) {
      const c = getClient(cfg);
      const q = buildQuery(args);
      if (!q) throw new Error("query 不能为空");
      const product = ["Top", "Media"].includes(args.product) ? args.product : "Latest";
      const pages = Math.max(1, Math.min(Number(args.pages) || cfg.pages, 10));
      const { tweets, nextCursor } = await paged(
        cfg,
        () => c.search(q, { product, count: 20, cursor: args.cursor }),
        (cur) => c.search(q, { product, count: 20, cursor: cur }),
        pages,
      );
      const limit = Math.max(1, Math.min(Number(args.limit) || cfg.limit, 100));
      const out = tweets.slice(0, limit).map(brief);
      return {
        query: q,
        product,
        returned: out.length,
        tweets: out,
        nextCursor: nextCursor || undefined,
        note: out.length ? undefined : "没搜到：换个词，或确认 x_auth 是否可用",
      };
    },
  }));

  /* ---------------- 看人 ---------------- */
  register(defineTool({
    name: "x_user",
    description:
      "查一个 X 账号的资料（昵称、简介、粉丝/关注/推文数、是否认证、注册时间、主页链接），可选同时拉他最近的推文。user 传 @handle 或数字 id 都行。",
    parameters: {
      user: { type: "string", description: "@handle 或数字用户 id" },
      kind: { type: "string", description: "看哪条时间线：tweets（默认，全部推文含转推）/ media（只带图视频的）/ replies（他的回复）/ originals（原创，不含转推）。填了 kind 会自动带上推文。" },
      withTweets: { type: "boolean", description: "是否同时返回推文（默认 false）" },
      limit: { type: "number", description: "推文条数（默认 20，上限 100）" },
      pages: { type: "number", description: "推文翻几页（默认 1）" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          user: { type: "object", additionalProperties: false },
          timeline: { type: "string" },
          tweets: { type: "array", items: { type: "object", additionalProperties: false } },
          nextCursor: { type: "string" },
        },
      },
    },
    async execute({ user, kind, withTweets, limit, pages } = {}) {
      const c = getClient(cfg);
      if (!user) throw new Error("user 不能为空");
      const idText = String(user).replace(/^@/, "").trim();
      const isNumericId = /^\d+$/.test(idText);
      if (isNumericId && !withTweets && !kind) {
        throw new Error("数字 id 查不到资料（X 的资料接口只认 handle），给 @handle，或加 withTweets:true");
      }
      const info = isNumericId
        ? { id: idText, user: null, note: "只给了数字 id，资料字段缺失" }
        : await c.userByScreenName(idText);
      const wantTweets = withTweets || !!kind;
      if (!wantTweets) return { user: info };
      const lim = Math.max(1, Math.min(Number(limit) || cfg.limit, 100));
      const view = kind || "tweets";
      const { tweets, nextCursor } = await paged(
        cfg,
        () => c.userTweets(info.id, { kind: view, count: 20 }),
        (cur) => c.userTweets(info.id, { kind: view, count: 20, cursor: cur }),
        Math.max(1, Math.min(Number(pages) || cfg.pages, 10)),
      );
      return {
        user: info,
        timeline: view,
        tweets: tweets.slice(0, lim).map(brief),
        nextCursor: nextCursor || undefined,
      };
    },
  }));

  /* ---------------- 看对话 ---------------- */
  register(defineTool({
    name: "x_thread",
    description:
      "拉一条推文下面的对话（主贴 + 回复/引用，按 X 的相关度排序）。tweetId 传数字 id 或推文链接都行。用来读懂一条热帖下面的讨论。",
    parameters: {
      tweetId: { type: "string", description: "推文 id 或 https://x.com/<user>/status/<id> 链接" },
      limit: { type: "number", description: "最多返回多少条（默认 30，上限 100）" },
      pages: { type: "number", description: "翻几页拿更多回复（默认 1，上限 10）；热帖几百条回复时用" },
      cursor: { type: "string", description: "上一页返回的 nextCursor，用于继续翻" },
      onlyReplies: { type: "boolean", description: "只保留别人对它的回复（去掉主贴本身）" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          focalId: { type: "string" },
          returned: { type: "number" },
          tweets: { type: "array", items: { type: "object", additionalProperties: false } },
          nextCursor: { type: "string" },
        },
      },
    },
    async execute({ tweetId, limit, pages, cursor, onlyReplies } = {}) {
      if (!tweetId) throw new Error("tweetId 不能为空");
      const id = String(tweetId).match(/(\d{6,})/)?.[1];
      if (!id) throw new Error(`没从 "${tweetId}" 里认出推文 id`);
      const c = getClient(cfg);
      const { tweets, nextCursor } = await paged(
        cfg,
        () => c.thread(id, { cursor }),
        (cur) => c.thread(id, { cursor: cur }),
        Math.max(1, Math.min(Number(pages) || 1, 10)),
      );
      const lim = Math.max(1, Math.min(Number(limit) || 30, 100));
      const list = onlyReplies ? tweets.filter((t) => t.id !== id) : tweets;
      return {
        focalId: id,
        returned: Math.min(list.length, lim),
        tweets: list.slice(0, lim).map(brief),
        nextCursor: nextCursor || undefined,
      };
    },
  }));

  ctx.logger?.info?.(`[x-search] 就绪（limit=${cfg.limit} pages=${cfg.pages}）${lastError ? " · 凭证缺失: " + lastError : ""}`);
}

export { XClient, walkTweets };
