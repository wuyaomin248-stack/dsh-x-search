// 从 x.com 的 main bundle 里提取 operationName → queryId 映射，落 lib/operations.json。
// queryId 每次发版都会变，插件启动时也会走同一条正则，所以这里的提取逻辑必须和插件一致。
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const WANT = ['SearchTimeline', 'UserByScreenName', 'UserTweets', 'TweetDetail', 'HomeTimeline', 'HomeLatestTimeline', 'UserTweetsAndReplies', 'SearchAdaptive'];

const jar = JSON.parse(fs.readFileSync('E:/工作2/.tmp/x-cookies.json', 'utf8'));
const cookie = jar.cookies.filter((c) => /(^|\.)x\.com$/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join('; ');
const get = async (url) => {
  const r = await fetch(url, { headers: { cookie, 'user-agent': UA } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.text();
};

const html = await get('https://x.com/');
const main = (/src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[^"]+)"/.exec(html) || [])[1];
if (!main) throw new Error('没找到 main bundle');
console.log('[main]', main);
const js = await get(main);
console.log('[bundle]', (js.length / 1024 / 1024).toFixed(2), 'MB');

// 两种常见形态：{queryId:"...",operationName:"..."} 与 queryId:"..." 近旁出现 operationName
const pairs = new Map();
for (const m of js.matchAll(/queryId:"([A-Za-z0-9_-]{10,})"[^}]{0,120}?operationName:"([A-Za-z]+)"/g)) pairs.set(m[2], m[1]);
for (const m of js.matchAll(/operationName:"([A-Za-z]+)"[^}]{0,120}?queryId:"([A-Za-z0-9_-]{10,})"/g)) if (!pairs.has(m[1])) pairs.set(m[1], m[2]);
console.log('[pairs]', pairs.size);

const out = {};
for (const k of WANT) {
  const v = pairs.get(k);
  if (v) out[k] = v;
  console.log(`  ${k.padEnd(22)} ${v || '(missing)'}`);
}

// 旧样本里的值做对照，证明提取法抓的是同一份东西
const sample = JSON.parse(fs.readFileSync('E:/工作2/x-search-ext/samples/index.json', 'utf8')).find((x) => x.op === 'SearchTimeline');
const sampleId = new URL(sample.url).pathname.split('/')[4];
console.log('[sample SearchTimeline]', sampleId, sampleId === out.SearchTimeline ? 'MATCH' : 'DIFF');

if (Object.keys(out).length) {
  fs.writeFileSync('E:/工作2/dsh-x-search/lib/operations.json', JSON.stringify(out, null, 1));
  console.log('[saved] lib/operations.json');
}

// features：把 bundle 里能拿到的 SearchTimeline features 对象捞出来（拿不到就算了，用内置默认）
const featMatch = /features:\{([^{}]{200,4000})\}/.exec(js);
console.log('[features 候选]', featMatch ? featMatch[0].length + ' 字符' : 'none');
if (featMatch) fs.writeFileSync('E:/工作2/dsh-x-search/tools/features-candidate.txt', featMatch[0]);
