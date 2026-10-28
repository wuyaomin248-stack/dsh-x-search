// 命令行入口：既是自测，也是不装插件时的即时用法。
//   node tools/cli.mjs whoami
//   node tools/cli.mjs search "kiro" --product Latest|Top|Media --count 20 --pages 3
//   node tools/cli.mjs user elonmusk --kind media|replies|originals|tweets
//   node tools/cli.mjs tweets elonmusk --kind media --count 10
//   node tools/cli.mjs thread 1234567890 --pages 3
// 需要代理时先 $env:HTTPS_PROXY='http://127.0.0.1:7890'
import { XClient } from '../lib/xapi.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; flags[k] = v; }
  else args.push(a);
}
const num = (v, d) => Math.max(1, Number(v) || d);

const short = (t) => {
  const d = new Date(t.ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const show = (tweets, limit = 20) => {
  for (const t of tweets.slice(0, limit)) {
    const m = (t.media || []).length ? ` [媒体×${(t.media || []).length}]` : '';
    console.log(`  ${short(t)} @${t.user} ♥${t.fav} ⟲${t.rt} 💬${t.reply} 👁${t.views}${m}`);
    console.log('    ' + t.text.replace(/\n/g, ' ').slice(0, 160));
  }
  if (tweets.length > limit) console.log(`  …共 ${tweets.length} 条`);
};
const client = new XClient();

try {
  if (cmd === 'whoami') {
    const t0 = Date.now();
    const r = await client.whoami();
    console.log('ok=%s probe=%s status=%s cred=%s shell来自磁盘=%s', r.ok, r.probe, r.status, client.credSource, !!client._shellFromDisk);
    const u = await client.userByScreenName('x').catch((e) => ({ error: e.message }));
    console.log('userByScreenName:', JSON.stringify(u).slice(0, 200));
    console.log('operations:', Object.keys(client._ops).length, '| features keys:', Object.keys(client.featuresFor('SearchTimeline')).length);
    console.log('[耗时]', Date.now() - t0, 'ms');
  } else if (cmd === 'search') {
    const q = args[0];
    if (!q) throw new Error('用法: cli.mjs search "关键词" [--product Latest|Top|Media] [--count 20] [--pages 3]');
    const pages = num(flags.pages, 1);
    const all = [];
    let cursor;
    for (let p = 0; p < pages; p++) {
      const r = await client.search(q, { product: flags.product || 'Latest', count: 20, cursor });
      all.push(...r.tweets);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const seen = new Set();
    const uniq = all.filter((t) => !seen.has(t.id) && seen.add(t.id));
    console.log(`[search] "${q}" ${uniq.length} 条（${pages} 页）nextCursor=${cursor ? '有' : '无'}`);
    show(uniq, num(flags.show, 20));
  } else if (cmd === 'user') {
    const u = await client.userByScreenName(args[0] || '@x');
    console.log(JSON.stringify(u, null, 1));
  } else if (cmd === 'tweets') {
    const u = await client.userByScreenName(args[0] || '@x');
    const kind = flags.kind || 'tweets';
    const pages = num(flags.pages, 1);
    const all = [];
    let cursor;
    for (let p = 0; p < pages; p++) {
      const r = await client.userTweets(u.id, { kind, count: 20, cursor });
      all.push(...r.tweets);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const seen = new Set();
    const uniq = all.filter((t) => !seen.has(t.id) && seen.add(t.id));
    console.log(`[tweets] @${u.user} kind=${kind} op=${kind} ${uniq.length} 条（${pages} 页）`);
    show(uniq, num(flags.show, 10));
  } else if (cmd === 'thread') {
    const id = String(args[0] || '').match(/(\d{6,})/)?.[1];
    if (!id) throw new Error('用法: cli.mjs thread <推文id或链接> [--pages 3]');
    const pages = num(flags.pages, 1);
    const all = [];
    let cursor;
    for (let p = 0; p < pages; p++) {
      const r = await client.thread(id, { cursor });
      all.push(...r.tweets);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const seen = new Set();
    const uniq = all.filter((t) => !seen.has(t.id) && seen.add(t.id));
    console.log(`[thread] ${id} ${uniq.length} 条（${pages} 页）`);
    show(uniq, num(flags.show, 10));
  } else {
    console.log('命令: whoami | search | user | tweets | thread');
  }
} catch (e) {
  console.error('[error]', e.message);
  process.exit(1);
}
