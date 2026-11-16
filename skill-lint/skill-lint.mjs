#!/usr/bin/env node
// skill-lint — 给 AI 技能（Agent Skills / SKILL.md）做体检测评，也能直接体检 GitHub 仓库
//
// 本地：
//   node skill-lint.mjs <目录>              体检该目录下所有技能
//   node skill-lint.mjs <目录> --json       输出 JSON
//   node skill-lint.mjs <目录> --md         输出 Markdown
//
// 远程（不需要 clone，也不写磁盘）：
//   node skill-lint.mjs --repo anthropics/skills
//   node skill-lint.mjs --repo K-Dense-AI/scientific-agent-skills --md
//
// 一个"技能" = 一个含 SKILL.md 的文件夹。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

// ---------- frontmatter ----------
// 只处理 SKILL.md 实际会用的子集：key: value、多行缩进续行、带引号的值、二级嵌套（metadata:）
function parseFront(text) {
  const src = text.replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { ok: false, data: {}, body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return { ok: false, data: {}, body: src };
  const data = {};
  let key = null, buf = [], nested = false;
  const flush = () => {
    if (!key) return;
    let v = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (v.startsWith('>') || v.startsWith('|')) v = v.slice(1).trim();
    v = v.replace(/^["']|["']$/g, '').trim();
    if (v) data[key] = v;
    key = null; buf = []; nested = false;
  };
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\s+$/, '');
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      flush();
      key = top[1];
      buf = top[2] ? [top[2]] : [];
      continue;
    }
    if (!key) continue;
    if (/^\s+\S/.test(line)) {
      // 二级字段（如 metadata: 下的 version:）不算续行
      if (/^\s+[A-Za-z_][\w-]*:\s/.test(line)) { nested = true; continue; }
      if (!nested) buf.push(line.trim());
      continue;
    }
    if (!line.trim()) continue;
    flush();
  }
  flush();
  return { ok: true, data, body: lines.slice(end + 1).join('\n') };
}

// ---------- 正文里引用的相对文件 ----------
const REF_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w\u4e00-\u9fff][\w\u4e00-\u9fff./\-]*\.(?:md|py|js|mjs|cjs|json|ya?ml|toml|sh|ps1|txt|html|css|ts))(?=[\s`'")\],。；]|$)/g;

function collectRefs(body) {
  const out = new Set();
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(body))) {
    const p = m[1];
    if (/^https?:/i.test(p)) continue;
    out.add(p.replace(/^\.\//, ''));
  }
  return [...out];
}

function listFiles(root, limit = 5000) {
  const out = [];
  const walk = (d, rel) => {
    if (out.length >= limit) return;
    let es = [];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else if (out.length < limit) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// ---------- 规则 ----------
const MAX_DESC = 1024;
const TRIGGER_HINTS = ['use when', 'use this', 'use it when', 'use for', 'use it for', 'use to', 'used when', 'used for',
  'when the user', 'when a user', 'when to use', 'whenever', 'applies to', 'read before', 'trigger',
  '当用户', '当需要', '触发', '使用时', '如果你需要', '适用于', '适合', '用于'];
const BOUNDARY_HINTS = ['do not use', "don't use", 'not for', 'not suitable', 'skip only', 'skip when', 'skip this',
  'out of scope', 'not applicable', 'only when', 'must not', 'decline', 'refuse',
  '不适用', '不用于', '不要用', '边界', '不承诺', '不负责', '跳过', '仅在', '必须先'];

function lintText({ text, dirName, allFiles, absDir, parentFiles }) {
  const issues = [];
  const fm = parseFront(text);
  const body = fm.body || '';
  const name = fm.data.name || '';
  const desc = fm.data.description || '';

  // 1 frontmatter 三件套
  if (!fm.ok) issues.push(['fail', 'frontmatter', 'SKILL.md 开头没有合法的 --- frontmatter，模型读不到元数据，技能等于没装']);
  else {
    if (!name) issues.push(['fail', 'name', 'frontmatter 缺 name 字段']);
    if (!desc) issues.push(['fail', 'description', 'frontmatter 缺 description 字段（决定它会不会被加载的就这一个字段）']);
  }

  // 2 命名
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    issues.push(['warn', 'name-format', `name「${name}」不是小写连字符格式，部分客户端加载会失败`]);
  if (name && dirName && name !== dirName)
    issues.push(['warn', 'name-dir', `name「${name}」与文件夹名「${dirName}」不一致`]);

  // 3 description 长度
  const dl = desc.length;
  if (dl > MAX_DESC) issues.push(['fail', 'desc-long', `description ${dl} 字，超过 ${MAX_DESC} 上限会被客户端截断`]);
  else if (dl > 0 && dl < 40) issues.push(['warn', 'desc-short', `description 只有 ${dl} 字，太短，模型判断不了何时该加载`]);
  else if (dl > 700) issues.push(['warn', 'desc-bloat', `description ${dl} 字偏长，触发精度会下降（建议 150–500）`]);

  // 4 触发词
  const dlc = desc.toLowerCase();
  if (desc && !TRIGGER_HINTS.some((h) => dlc.includes(h)))
    issues.push(['warn', 'no-trigger', 'description 里没有明确的触发条件（如 "当用户…时使用" / "Use when…"），容易被模型忽略']);

  // 5 正文体量
  const trimmed = body.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const charCount = body.replace(/\s/g, '').length;
  if (charCount === 0) issues.push(['fail', 'empty-body', 'SKILL.md 只有 frontmatter，没有正文指令']);
  else if (words > 6000) issues.push(['warn', 'body-bloat', `正文约 ${words} 词，偏长；建议把细节挪到 references/ 按需读取`]);

  // 6 引用断链：只查「技能自带的资料目录」里的引用（references/、scripts/、assets/ 等）。
  // 正文里的 src/utils/format.ts 这类是举例用的伪路径，不是断链——早期版本把它们全报成断链，全是噪音。
  const BUNDLE_DIRS = ['references', 'reference', 'refs', 'scripts', 'assets', 'templates', 'template',
    'examples', 'example', 'evals', 'docs', 'doc', 'core', 'shared', 'static', 'data', 'vendor', 'prompts'];
  const refs = collectRefs(body).filter((r) => {
    const first = r.replace(/^\.{1,2}\//, '').split('/')[0];
    return BUNDLE_DIRS.includes(first) || r.startsWith('./') || r.startsWith('../');
  });
  let broken = [];
  if (allFiles && allFiles.length) {
    broken = refs.filter((r) => {
      const rel = r.replace(/^\.\//, '');
      if (existsSync(join(dirName, rel))) return false;
      if (allFiles.some((f) => f === rel || f.endsWith('/' + rel))) return false;
      // 多技能库常把共享资料放在库根（如 <lib>/_shared/core/x.md），而技能内写 shared/core/x.md。
      // 这类在同一技能目录里找不到、但在同级库里能找到的引用，不算断链。
      if (parentFiles && parentFiles.length) {
        const norm = rel.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
        if (parentFiles.some((f) => f === norm || f.endsWith('/' + norm)
          || f === '_' + norm || f.endsWith('/_' + norm))) return false;
      }
      return true;
    });
  }
  if (broken.length) issues.push(['warn', 'broken-ref', `${broken.length} 处引用的文件不存在：${broken.slice(0, 4).join('、')}${broken.length > 4 ? '…' : ''}`]);

  // 7 边界说明：既认"不要用/不适用"，也认"这个交给别的技能"的路由句（For X, see Y / 转到 / 交给）
  const blc = body.toLowerCase() + '\n' + desc.toLowerCase();
  const ROUTE_HINT = /for [^.\n]{2,40},?\s+see [a-z][a-z0-9-]{2,}/i;
  if (trimmed && !BOUNDARY_HINTS.some((h) => blc.includes(h)) && !ROUTE_HINT.test(blc))
    issues.push(['warn', 'no-boundary', '正文没有"什么时候不该用"的边界，容易被过度触发']);

  const fail = issues.filter((i) => i[0] === 'fail').length;
  const warn = issues.filter((i) => i[0] === 'warn').length;
  const score = Math.max(0, 100 - fail * 18 - warn * 6);

  return { name: name || dirName, score, fail, warn, issues, words, charCount, descLen: dl, refs: refs.length };
}

function lintDir(dir, parentFiles) {
  const mdPath = join(dir, 'SKILL.md');
  let text;
  try { text = readFileSync(mdPath, 'utf8'); } catch { return null; }
  return { ...lintText({ text, dirName: basename(dir), allFiles: listFiles(dir), parentFiles }), dir };
}

// ---------- 本地遍历 ----------
function collectLocal(target) {
  const skills = [];
  const rootFiles = listFiles(target, 20000);   // 库根的全部文件，用于识别跨技能的共享目录（_shared/ 等）
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const r = lintDir(d, rootFiles);
      if (r) skills.push(r);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(join(d, e.name), depth + 1);
    }
  };
  walk(target, 0);
  return skills;
}

// ---------- 远程（GitHub，无需 clone）----------
// 两条路，优先走 tarball：
//   1) codeload.github.com 的 tar.gz —— 不消耗 API 限额，一次拿全仓库（本机实测 200 可达）
//   2) api.github.com contents API —— 限额 60 次/小时/IP，超了会返回 200 但正文是限流 JSON
// 注意 raw.githubusercontent.com 在本机不通（fetch failed），别用。
// 有 token 就设 GH_TOKEN，contents 路线的限额提到 5000/小时。
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const UA = { 'user-agent': 'skill-lint' };
const GHAPI = { ...UA, accept: 'application/vnd.github+json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rateLimited = 0;
const MAX_TARBALL = 80 * 1024 * 1024; // 超过这个大小不整包下载

// 极简 tar 解析：只需要「全部文件路径」+「所有 SKILL.md 的内容」，支持 ustar 前缀与 pax 长路径
function parseTar(buf) {
  const files = [];           // 所有 blob 的相对路径（已剥掉 <repo>-<branch>/ 顶层目录）
  const texts = new Map();    // 相对路径 -> SKILL.md 内容
  let off = 0, paxPath = null;
  const strip = (p) => p.replace(/^[^/]+\//, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (s, e) => { const z = h.subarray(s, e); const i = z.indexOf(0); return z.subarray(0, i < 0 ? undefined : i).toString('utf8'); };
    const size = parseInt(str(124, 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156]) || '0';
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = prefix + '/' + name;
    off += 512;
    const body = buf.subarray(off, off + size);
    if (type === 'x') { // pax 扩展头：下一项的真实路径
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) paxPath = m[1];
    } else if (type === '0' || type === '\u0000') {
      const p = strip(paxPath || name);
      paxPath = null;
      if (p) {
        files.push(p);
        if (/(^|\/)SKILL\.md$/i.test(p)) texts.set(p, body.toString('utf8'));
      }
    } else {
      paxPath = null;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return { files, texts };
}

async function collectFromTarball(repo, branch) {
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
  const head = await fetch(url, { method: 'HEAD', headers: UA });
  if (!head.ok) throw new Error(`tarball HEAD ${head.status}`);
  const len = Number(head.headers.get('content-length') || 0);
  if (len > MAX_TARBALL) throw new Error(`仓库打包后 ${(len / 1048576).toFixed(0)}MB，超过 ${MAX_TARBALL / 1048576}MB 上限`);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`tarball ${r.status}`);
  const gz = Buffer.from(await r.arrayBuffer());
  const raw = gunzipSync(gz);
  return parseTar(raw);
}
function looksLikeApiError(text) {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  try {
    const j = JSON.parse(t);
    return !!(j.message && (j.documentation_url || /rate limit/i.test(j.message)));
  } catch { return false; }
}

async function ghText(repo, path, ref) {
  const url = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { ...GHAPI, accept: 'application/vnd.github.raw' } });
    const text = await r.text();
    if (r.ok && !looksLikeApiError(text)) return text;
    if (r.status === 403 || r.status === 429 || (r.ok && looksLikeApiError(text))) {
      rateLimited++;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${r.status} for ${path}`);
  }
  throw new Error(`限流：${path}`);
}

async function collectRemote(repo) {
  // 只需要仓库默认分支，可先试 main，失败再试 master；仓库元数据顺手取（失败不影响）
  let meta = {};
  try {
    const m = await (await fetch(`https://api.github.com/repos/${repo}`, { headers: GHAPI })).json();
    if (!m.message) meta = m;
  } catch { /* 忽略 */ }
  const branch = meta.default_branch || 'main';

  let pack = null, via = '';
  // 分支可能不是 main（拿不到仓库元数据时猜错），依次试
  const branches = [...new Set([meta.default_branch, 'main', 'master'].filter(Boolean))];
  for (const b of branches) {
    try {
      pack = await collectFromTarball(repo, b);
      via = `tarball/${b}`;
      break;
    } catch (e) {
      via = `tarball ${b} 失败：${String(e.message).slice(0, 50)}`;
    }
  }
  if (!pack) via = 'contents API';

  const results = [];
  if (pack) {
    const { files, texts } = pack;
    for (const [p, text] of texts) {
      const dirPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      const dirName = dirPath ? dirPath.split('/').pop() : repo.split('/').pop();
      const siblings = files.filter((f) => dirPath === '' || f.startsWith(dirPath + '/'));
      results.push({ ...lintText({ text, dirName, allFiles: siblings }), path: dirPath || '(根目录)', url: `https://github.com/${repo}/tree/${branch}/${dirPath}` });
    }
  } else {
    // 退路：contents API 逐个读
    const tree = await (await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, { headers: GHAPI })).json();
    if (!tree.tree) throw new Error(`读不到文件树：${tree.message || '未知'}`);
    const all = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
    const mds = all.filter((f) => f === 'SKILL.md' || f.toLowerCase().endsWith('/skill.md'));
    for (let i = 0; i < mds.length; i += 4) {
      const batch = mds.slice(i, i + 4);
      const got = await Promise.all(batch.map(async (p) => {
        const dirPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        const dirName = dirPath ? dirPath.split('/').pop() : repo.split('/').pop();
        try {
          const text = await ghText(repo, p, branch);
          const siblings = all.filter((f) => dirPath === '' || f.startsWith(dirPath + '/'));
          return { ...lintText({ text, dirName, allFiles: siblings }), path: dirPath || '(根目录)', url: `https://github.com/${repo}/tree/${branch}/${dirPath}` };
        } catch { return null; }
      }));
      results.push(...got.filter(Boolean));
      if (i + 4 < mds.length) await sleep(TOKEN ? 120 : 400);
    }
  }

  return { meta, list: results, total: results.length, via };
}
// ---------- 渲染 ----------
const grade = (s) => (s >= 90 ? 'A' : s >= 78 ? 'B' : s >= 62 ? 'C' : s >= 45 ? 'D' : 'E');

function renderTty(list, title) {
  const total = list.length;
  const clean = list.filter((s) => !s.fail && !s.warn).length;
  const failing = list.filter((s) => s.fail > 0).length;
  const avg = Math.round(list.reduce((a, s) => a + s.score, 0) / (total || 1));
  const out = [];
  if (title) out.push(title, '');
  out.push(`${C.b}体检 ${total} 个技能${C.x}  平均 ${avg} 分　完全合格 ${clean} 个　有硬伤 ${failing} 个`);
  out.push('');
  for (const s of list) {
    out.push(`${C.b}${s.name}${C.x}  ${grade(s.score)} ${s.score}分  ${C.d}${s.charCount}字 / desc ${s.descLen}${C.x}`);
    for (const [lv, id, msg] of s.issues) {
      const col = lv === 'fail' ? C.r : C.y;
      out.push(`   ${col}${lv === 'fail' ? '✗' : '!'}${C.x} ${C.d}${id}${C.x}  ${msg}`);
    }
    if (!s.issues.length) out.push(`   ${C.g}✓${C.x} ${C.d}没有发现问题${C.x}`);
  }
  return out.join('\n');
}

function renderMd(list, source) {
  const total = list.length;
  const avg = Math.round(list.reduce((a, s) => a + s.score, 0) / (total || 1));
  const clean = list.filter((s) => !s.fail && !s.warn).length;
  const out = ['# 技能体检报告', '', `- 体检对象：\`${source}\``,
    `- 技能数：**${total}**　平均分：**${avg}**　零问题：**${clean}**`, '',
    '| 技能 | 分数 | 等级 | 硬伤 | 提醒 | 正文字数 | description |',
    '|---|---:|---|---:|---:|---:|---:|'];
  for (const s of list) out.push(`| ${s.name} | ${s.score} | ${grade(s.score)} | ${s.fail} | ${s.warn} | ${s.charCount} | ${s.descLen} |`);
  out.push('', '## 逐条问题');
  for (const s of list) {
    if (!s.issues.length) continue;
    out.push('', `### ${s.name}（${s.score} 分）`);
    for (const [lv, id, msg] of s.issues) out.push(`- ${lv === 'fail' ? '**硬伤**' : '提醒'} \`${id}\` — ${msg}`);
  }
  return out.join('\n');
}

// ---------- main ----------
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

export { lintText, lintDir, collectLocal, collectRemote, renderMd, renderTty, grade, parseTar, parseFront, collectRefs };

if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const md = args.includes('--md');
  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : null;
  const target = args.find((a) => !a.startsWith('--') && a !== repo);

  if (!repo && !target) {
    console.error('用法:\n  node skill-lint.mjs <技能目录> [--json|--md]\n  node skill-lint.mjs --repo <owner/name> [--json|--md]');
    process.exit(2);
  }

  let list = [], title = '';
  if (repo) {
    const { meta, list: r, total, via } = await collectRemote(repo);
    list = r.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const star = meta.stargazers_count != null ? `★${meta.stargazers_count}` : '';
    title = [meta.full_name || repo, star, meta.description || ''].filter(Boolean).join('  ');
    if (!list.length) {
      console.error(`${repo} 里一个 SKILL.md 都没读下来（读取方式：${via}）。`);
      console.error(rateLimited ? '原因大概率是 GitHub 未认证限额（60 次/小时/IP）已耗尽。' : '原因未知，先确认仓库可公开访问。');
      console.error('解决：设置环境变量 GH_TOKEN=<你的只读 PAT>，限额提到 5000/小时。');
      process.exit(1);
    }
    if (list.length < total) console.error(`（${total - list.length} 个没能读下来，结果不完整——多半是撞到限额）`);
  } else {
    if (!existsSync(target)) { console.error(`目录不存在: ${target}`); process.exit(2); }
    list = collectLocal(target).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  }

  if (!list.length) { console.error('没找到任何含 SKILL.md 的技能'); process.exit(1); }
  if (json) console.log(JSON.stringify(list, null, 2));
  else if (md) console.log(renderMd(list, repo || target));
  else console.log(renderTty(list, title));
}
