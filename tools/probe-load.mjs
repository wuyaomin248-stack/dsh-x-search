// 加载自检（不依赖真实 @deepseek-ai/* 包）：
// dsh-tools / schemastery 只在 DSH 的 Electron 进程里可解析（打在 app.asar 内），
// 纯 Node 下会 ERR_MODULE_NOT_FOUND。所以这里把两个 import 换成等价 stub 再跑 apply，
// 验证的是「插件自身」：能不能加载、apply 会不会抛、4 个工具是否都注册上、render 能否出文本。
// 用法: node tools/probe-load.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = path.join(ROOT, 'tools', 'stubs');
const TMP = path.join(ROOT, 'lib', '.load-check.tmp.mjs');

fs.mkdirSync(STUB_DIR, { recursive: true });

fs.writeFileSync(path.join(STUB_DIR, 'dsh-tools.mjs'), `
// 最小 stub：真实 defineTool 会包 render，这里原样返回，够验证结构
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineTool 需要 spec 对象');
  if (!spec.name) throw new Error('defineTool 缺 name');
  if (!spec.execute) throw new Error('defineTool 缺 execute: ' + spec.name);
  return spec;
}
export default { defineTool };
`);

fs.writeFileSync(path.join(STUB_DIR, 'schemastery.mjs'), `
// 最小 stub：只实现本插件用到的 z.object / z.string / z.number / z.boolean + .default()
const mk = (type) => {
  const o = { type };
  o.default = (v) => ({ ...o, default: v });
  return o;
};
const z = {
  object: (shape) => ({ type: 'object', shape }),
  string: () => mk('string'),
  number: () => mk('number'),
  boolean: () => mk('boolean'),
};
export default z;
export { z };
`);

const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  .replace('from "@deepseek-ai/dsh-tools"', `from ${JSON.stringify(pathToFileURL(path.join(STUB_DIR, 'dsh-tools.mjs')).href)}`)
  .replace('from "@deepseek-ai/schemastery"', `from ${JSON.stringify(pathToFileURL(path.join(STUB_DIR, 'schemastery.mjs')).href)}`);
fs.writeFileSync(TMP, src);

const tools = [];
const logs = [];
const ctx = {
  tools: { register: (t) => { tools.push(t); return () => {}; } },
  logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m), error: console.error },
  effect: () => {},
};

let fail = 0;
const ok = (c, label, extra) => {
  if (c) console.log('  ok  ' + label);
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

console.log('[load]');
let mod;
try {
  mod = await import(pathToFileURL(TMP).href + '?t=' + Date.now());
  ok(true, 'lib/index.js 能被加载');
} catch (e) {
  ok(false, 'lib/index.js 能被加载', e.message);
  fs.rmSync(TMP, { force: true });
  process.exit(1);
}

ok(mod.name === 'dsh-x-search', '导出插件名', mod.name);
ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 含 tools', mod.inject);
ok(typeof mod.apply === 'function', '导出 apply');
ok(mod.Config && typeof mod.Config === 'object', '导出 Config');

console.log('[apply]');
try {
  mod.apply(ctx, { limit: 15, pages: 2 });
  ok(true, 'apply 不抛错');
} catch (e) {
  ok(false, 'apply 不抛错', e.message);
  fs.rmSync(TMP, { force: true });
  process.exit(1);
}
ok(logs.some((l) => l.startsWith('info')), 'apply 里打了就绪日志', logs);
ok(tools.length === 4, '注册 4 个工具', tools.map((t) => t.name));

console.log('[tools]');
for (const t of tools) {
  ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} 有像样的描述`);
  ok(t.output && t.output.schema, `${t.name} 有 output.schema`);
  ok(typeof t.output.render === 'function', `${t.name} 有 output.render`);
  const r = t.output.render({}, { hello: 'world', n: 1 });
  ok(Array.isArray(r) && r[0]?.type === 'text' && r[0].text.includes('world'), `${t.name} render 能出文本`);
  ok(t.parameters && typeof t.parameters === 'object' && Object.keys(t.parameters).length > 0, `${t.name} 有 parameters`);
  ok(typeof t.execute === 'function', `${t.name} 有 execute`);
}

console.log('[param names]');
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
ok(!!byName.x_search.parameters.query, 'x_search.query 存在');
ok(!!byName.x_search.parameters.cursor, 'x_search.cursor 存在（可分页）');
ok(/高级搜索语法/.test(byName.x_search.parameters.query.description || ''), 'x_search.query 描述提到高级语法');
ok(!!byName.x_search.parameters.minFav && !!byName.x_search.parameters.since, 'x_search 有 minFav / since');
ok(!!byName.x_user.parameters.user && !!byName.x_user.parameters.withTweets, 'x_user 有 user / withTweets');
ok(!!byName.x_thread.parameters.tweetId, 'x_thread 有 tweetId');
ok(!!byName.x_auth.parameters.authToken && !!byName.x_auth.parameters.ct0, 'x_auth 有 authToken / ct0');

console.log('[execute 参数名一致]');
// execute 解构的参数名必须是 parameters 里声明过的，否则模型传进来会被丢掉
for (const t of tools) {
  const m = /async execute\(\{([^}]*)\}/.exec(t.execute.toString());
  if (!m) continue;
  const used = m[1].split(',').map((x) => x.split('=')[0].trim()).filter(Boolean);
  const declared = Object.keys(t.parameters);
  const ghost = used.filter((u) => !declared.includes(u));
  ok(ghost.length === 0, `${t.name} execute 只用声明过的参数`, ghost);
}

fs.rmSync(TMP, { force: true });
console.log(fail ? `\n${fail} 项失败` : '\n加载自检全部通过');
process.exit(fail ? 1 : 0);
