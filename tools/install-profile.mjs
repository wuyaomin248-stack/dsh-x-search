// 把 dsh-x-search 注册进 desktop profile（改 package.json 的两个位置）。
// 幂等：已经加过就只报告，不重复写。改完需要重启 DSH 才生效 —— 本脚本不重启任何进程。
// 用法: node tools/install-profile.mjs [--dry]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dry = process.argv.includes('--dry');
const PROF = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PKG = path.join(PROF, 'package.json');
const DEP = 'link:E:/工作2/dsh-x-search';
const NAME = 'dsh-x-search';

if (!fs.existsSync(PKG)) throw new Error('找不到 profile: ' + PKG);
const raw = fs.readFileSync(PKG, 'utf8');
const pkg = JSON.parse(raw);

pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

const changes = [];
if (pkg.dependencies[NAME] !== DEP) {
  changes.push(`dependencies["${NAME}"]: ${pkg.dependencies[NAME] || '(无)'} → ${DEP}`);
  pkg.dependencies[NAME] = DEP;
}
if (!pkg.dsh.profile.bundles.includes(NAME)) {
  changes.push(`dsh.profile.bundles: 追加 ${NAME}（当前 ${pkg.dsh.profile.bundles.length} 项）`);
  pkg.dsh.profile.bundles.push(NAME);
}

if (!changes.length) {
  console.log('[skip] 已经装过了，无需改动');
} else {
  console.log('[changes]');
  for (const c of changes) console.log('  - ' + c);
  if (dry) {
    console.log('[dry] 没写盘');
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${PKG}.bak-${stamp}`;
    fs.copyFileSync(PKG, bak);
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[backup]', bak);
    console.log('[written]', PKG);
    console.log('[next] 重启 DSH Desktop 后生效（本脚本不重启）');
  }
}

// junction 检查
const link = path.join(PROF, 'node_modules', NAME);
const exists = fs.existsSync(link);
console.log(`[junction] ${link} → ${exists ? '已存在' : '缺失，需手动 mklink /J'}`);
if (!exists) {
  console.log(`   mklink /J "${link}" "E:\\工作2\\dsh-x-search"`);
}
