// x-client-transaction-id 生成器（零依赖，只 node:crypto）
// 算法来源：npm `x-client-transaction-id` 0.3.2（MIT, github.com/Lqm1/x-client-transaction-id），
// 去掉 linkedom 依赖，HTML 用正则解析。
//
// 原料全部来自未登录也有的 x.com 首页 HTML：
//   1. <meta name="twitter-site-verification" content="..."> → 48 字节 key
//   2. webpack runtime 里的 ondemand.s 文件名 → 追加 JS，里面藏着行号与字节索引
//   3. 4 个 <svg id="loading-x-anim-N"> 的第 2 条 path → 动画关键帧
import { createHash } from 'node:crypto';

const ONDEMAND_RE = /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/s;
// 真机上索引是 1-2 位（keyBytes 只有 48 字节），放宽到 3 位以防 X 把 key 加长
const INDICES_RE = /\(\w\[(\d{1,3})\],\s*16\)/g;
const KEYWORD = 'obfiowerehiring';
const TIME_EPOCH = 1682924400; // 2023-05-01T00:00:00Z
const TOTAL_TIME = 4096;

const int = (v) => parseInt(v, 10);
const num = (v) => Number(v);

// ---------- HTML 原料
export function extractKey(html) {
  const m = /name="twitter-site-verification"\s+content="([^"]+)"/.exec(html)
    || /content="([^"]+)"\s+name="twitter-site-verification"/.exec(html);
  if (!m) throw new Error('首页里没有 twitter-site-verification（可能被重定向到登录页）');
  return m[1];
}

export function extractOndemandUrl(html) {
  const m = ONDEMAND_RE.exec(html);
  if (!m) throw new Error('首页里没找到 ondemand.s 的 chunk 名（webpack runtime 变了）');
  return `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${m[2]}a.js`;
}

export function extractIndices(src) {
  const hits = [];
  let m;
  INDICES_RE.lastIndex = 0;
  while ((m = INDICES_RE.exec(src)) !== null) hits.push(int(m[1]));
  if (!hits.length) throw new Error('ondemand.s 里没匹配到索引正则 (\\w[N], 16)');
  return { rowByteIndex: hits[0], keyByteIndices: hits.slice(1) };
}

// 4 个动画帧，各取第 2 条 path 的 d
export function extractFramePaths(html) {
  const out = [];
  for (let i = 0; ; i++) {
    const start = html.indexOf(`id="loading-x-anim-${i}"`);
    if (start < 0) break;
    const end = html.indexOf('</svg>', start);
    const chunk = html.slice(start, end < 0 ? start + 4000 : end);
    const paths = [...chunk.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((x) => x[1]);
    out.push(paths[1] || paths[0] || '');
  }
  if (!out.length) throw new Error('首页里没有 loading-x-anim 帧');
  return out;
}

function to2dArray(d) {
  return d.substring(9).split('C').map((seg) => {
    const cleaned = seg.replace(/[^\d]+/g, ' ').trim();
    return cleaned === '' ? [] : cleaned.split(/\s+/).map(num);
  });
}

// ---------- 数学（照抄，精度必须一致）
class Cubic {
  constructor(curves) { this.curves = curves; }
  calculate(a, b, m) {
    return 3.0 * a * (1 - m) * (1 - m) * m + 3.0 * b * (1 - m) * m * m + m * m * m;
  }
  getValue(time) {
    let startGradient = 0, endGradient = 0, start = 0.0, mid = 0.0, end = 1.0;
    if (time <= 0.0) {
      if (this.curves[0] > 0.0) startGradient = this.curves[1] / this.curves[0];
      else if (this.curves[1] === 0.0 && this.curves[2] > 0.0) startGradient = this.curves[3] / this.curves[2];
      return startGradient * time;
    }
    if (time >= 1.0) {
      if (this.curves[2] < 1.0) endGradient = (this.curves[3] - 1.0) / (this.curves[2] - 1.0);
      else if (this.curves[2] === 1.0 && this.curves[0] < 1.0) endGradient = (this.curves[1] - 1.0) / (this.curves[0] - 1.0);
      return 1.0 + endGradient * (time - 1.0);
    }
    while (start < end) {
      mid = (start + end) / 2;
      const xEst = this.calculate(this.curves[0], this.curves[2], mid);
      if (Math.abs(time - xEst) < 0.00001) return this.calculate(this.curves[1], this.curves[3], mid);
      if (xEst < time) start = mid; else end = mid;
    }
    return this.calculate(this.curves[1], this.curves[3], mid);
  }
}

const interpolateNum = (a, b, f) => (typeof a === 'number' && typeof b === 'number' ? a * (1 - f) + b * f : 0);
const interpolate = (from, to, f) => from.map((v, i) => interpolateNum(v, to[i], f));
const rotationToMatrix = (deg) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)];
};
const isOdd = (n) => (n % 2 ? -1.0 : 0.0);

function floatToHex(x) {
  const result = [];
  let quotient = Math.floor(x);
  let fraction = x - quotient;
  while (quotient > 0) {
    quotient = Math.floor(x / 16);
    const remainder = Math.floor(x - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : remainder.toString());
    x = quotient;
  }
  if (fraction === 0) return result.join('');
  result.push('.');
  while (fraction > 0) {
    fraction *= 16;
    const integer = Math.floor(fraction);
    fraction -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : integer.toString());
  }
  return result.join('');
}

function solve(value, minVal, maxVal, rounding) {
  const r = (value * (maxVal - minVal)) / 255 + minVal;
  return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
}

function animate(frames, targetTime) {
  const fromColor = frames.slice(0, 3).concat(1).map(num);
  const toColor = frames.slice(3, 6).concat(1).map(num);
  const fromRotation = [0.0];
  const toRotation = [solve(frames[6], 60.0, 360.0, true)];
  const curves = frames.slice(7).map((item, counter) => solve(item, isOdd(counter), 1.0, false));
  const val = new Cubic(curves).getValue(targetTime);
  const color = interpolate(fromColor, toColor, val).map((v) => (v > 0 ? v : 0));
  const rotation = interpolate(fromRotation, toRotation, val);
  const matrix = rotationToMatrix(rotation[0]);
  const strArr = color.slice(0, -1).map((v) => Math.round(v).toString(16));
  for (const v of matrix) {
    let rounded = Math.round(v * 100) / 100;
    if (rounded < 0) rounded = -rounded;
    const hex = floatToHex(rounded);
    strArr.push(hex.startsWith('.') ? `0${hex}`.toLowerCase() : hex || '0');
  }
  strArr.push('0', '0');
  return strArr.join('').replace(/[.-]/g, '');
}

// ---------- 组装
/**
 * @param {string} html   x.com 首页 HTML（带 cookie 或未登录都行）
 * @param {(url:string)=>Promise<string>} fetchText  下载 ondemand.s 的取文本函数（需要走代理）
 */
export async function prepare(html, fetchText) {
  const key = extractKey(html);
  const keyBytes = [...Buffer.from(key, 'base64')];
  if (keyBytes.length < 48) throw new Error(`key 长度异常: ${keyBytes.length}`);
  const { rowByteIndex, keyByteIndices } = extractIndices(await fetchText(extractOndemandUrl(html)));
  const paths = extractFramePaths(html);
  const arr = to2dArray(paths[keyBytes[5] % 4]);
  const rowIndex = keyBytes[rowByteIndex] % 16;
  const row = arr[rowIndex];
  if (!row || !row.length) throw new Error(`动画帧第 ${rowIndex} 行为空（arr=${arr.length} 行）`);
  let frameTime = keyByteIndices.reduce((a, b) => a * (keyBytes[b] % 16), 1);
  frameTime = Math.round(frameTime / 10) * 10;
  const animationKey = animate(row, frameTime / TOTAL_TIME);
  return { key, keyBytes, animationKey };
}

export function generate(ctx, method, path, timeNow) {
  const t = timeNow || Math.floor((Date.now() - TIME_EPOCH * 1000) / 1000);
  const timeBytes = [t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >> 24) & 0xff];
  const data = `${method}!${path}!${t}${KEYWORD}${ctx.animationKey}`;
  const hash = createHash('sha256').update(Buffer.from(data, 'utf8')).digest();
  const random = Math.floor(Math.random() * 256);
  const bytes = [...ctx.keyBytes, ...timeBytes, ...hash.subarray(0, 16), 3];
  const out = Buffer.alloc(bytes.length + 1);
  out[0] = random;
  for (let i = 0; i < bytes.length; i++) out[i + 1] = bytes[i] ^ random;
  return out.toString('base64').replace(/=/g, '');
}
