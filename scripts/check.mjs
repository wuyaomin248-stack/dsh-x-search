// 离线自检：不联网、不读 cookie。装完后先跑这个。
//   node scripts/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label);
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------- 1. 文件结构 ---------- */
console.log('[structure]');
const required = [
  'package.json', 'cordis.patch.yml', 'README.md', 'INSTALL.md',
  'lib/index.js', 'lib/xapi.mjs', 'lib/txid.mjs', 'lib/operations.json', 'lib/features.json',
  'test/unit.mjs', 'test/fixtures/search.json',
];
for (const f of required) ok(fs.existsSync(path.join(ROOT, f)), f);

/* ---------- 2. 语法 ---------- */
console.log('[syntax]');
const sources = ['lib/index.js', 'lib/xapi.mjs', 'lib/txid.mjs', 'test/unit.mjs', 'scripts/check.mjs', 'tools/cli.mjs'];
for (const f of sources) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); ok(true, f); }
  catch (e) { ok(false, f, String(e.stderr || e.message).slice(0, 200)); }
}

/* ---------- 3. 插件声明 ---------- */
console.log('[manifest]');
const pkg = JSON.parse(read('package.json'));
ok(pkg.name === 'dsh-x-search', 'package name', pkg.name);
ok(pkg.type === 'module', 'type=module');
ok(pkg.main === 'lib/index.js', 'main 指向 lib/index.js', pkg.main);
ok(pkg.dsh?.bundle?.patch === 'cordis.patch.yml', 'dsh.bundle.patch 声明了');
ok(read('cordis.patch.yml').includes("name: 'dsh-x-search'"), 'cordis.patch.yml 里有加载条目');

/* ---------- 4. 工具清单 ---------- */
console.log('[tools]');
const indexSrc = read('lib/index.js');
const toolNames = [...indexSrc.matchAll(/name:\s*"(x_[a-z_]+)"/g)].map((m) => m[1]);
const want = ['x_auth', 'x_search', 'x_user', 'x_thread'];
ok(toolNames.length === want.length, `工具数 ${want.length}`, toolNames);
for (const w of want) ok(toolNames.includes(w), `有 ${w}`);
ok(/export const inject = \["tools"\]/.test(indexSrc), 'inject 了 tools');
ok(/export const name = "dsh-x-search"/.test(indexSrc), '导出插件名');
ok(/export function apply\(ctx/.test(indexSrc), '导出 apply');
ok(!/ctx\.tools\.register\(/.test(indexSrc.replace(/const off = ctx\.tools\.register|try \{ return ctx\.tools\.register/g, '')), '没有绕过 register 壳直接注册');
ok(/defaultRender/.test(indexSrc), '有默认 render（缺 render 时实调会炸）');

/* ---------- 5. 数据表 ---------- */
console.log('[tables]');
const ops = JSON.parse(read('lib/operations.json'));
ok(Object.keys(ops).length > 50, `operations 条数 ${Object.keys(ops).length}`, Object.keys(ops).length);
for (const op of ['SearchTimeline', 'UserByScreenName', 'UserTweets', 'TweetDetail']) {
  ok(/^[A-Za-z0-9_-]{10,}$/.test(ops[op] || ''), `queryId: ${op}`, ops[op]);
}
const feats = JSON.parse(read('lib/features.json'));
ok(!!feats.SearchTimeline && Object.keys(feats.SearchTimeline).length >= 30, 'features.SearchTimeline 足够多');

/* ---------- 6. 敏感信息 ---------- */
console.log('[secrets]');
const scanFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // .tmp 是本地临时目录（.gitignore 里），里面可能有 GitHub sha 之类的 40 位十六进制，
    // 会被 auth_token 正则误伤；tools 是开发脚本，可能夹带抓包留下的临时数据。
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.tmp' || e.name === 'tools') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures') walk(p); continue; }
    if (/\.(js|mjs|json|md|yml)$/.test(e.name)) scanFiles.push(p);
  }
};
walk(ROOT);
const authTokenRe = /\b[0-9a-f]{40}\b/;
const ct0Re = /\b[0-9a-f]{160}\b/;
let leaked = [];
for (const f of scanFiles) {
  const t = fs.readFileSync(f, 'utf8');
  if (authTokenRe.test(t) || ct0Re.test(t)) leaked.push(path.relative(ROOT, f));
}
ok(leaked.length === 0, '仓库里没有明文 auth_token / ct0', leaked);
ok(!fs.existsSync(path.join(ROOT, 'x-search.json')), '没有把凭证文件打进包里');
ok(!/auth_token\s*=\s*"[0-9a-f]{40}"/.test(indexSrc), '源码里没有硬编码 auth_token');

/* ---------- 7. 单测 ---------- */
console.log('[unit]');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'test', 'unit.mjs')], { encoding: 'utf8', stdio: 'pipe' });
  const passed = (out.match(/^ {2}ok /gm) || []).length;
  ok(/全部通过/.test(out), `unit.mjs 全过（${passed} 项）`);
} catch (e) {
  ok(false, 'unit.mjs', String(e.stdout || e.message).slice(-400));
}

console.log(fail ? `\n${fail} 项失败` : '\n自检全部通过');
process.exit(fail ? 1 : 0);
