#!/usr/bin/env node
// 批量体检一批 GitHub 技能仓库：结果写 _data/<owner>-<repo>.json 与 _data/leaderboard.md
// 用法: node _batch.mjs
// 说明：不走 child_process（本沙箱 spawn node 会 EPERM），直接 import skill-lint.mjs 的函数。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRemote } from './skill-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = [
  'anthropics/skills',
  'addyosmani/agent-skills',
  'K-Dense-AI/scientific-agent-skills',
  'blader/humanizer',
  'coreyhaines31/marketingskills',
  'mvanhorn/last30days-skill',
  'ComposioHQ/awesome-claude-skills',
  'hesreallyhim/awesome-claude-code',
  'nextlevelbuilder/ui-ux-pro-max-skill',
  'multica-ai/andrej-karpathy-skills',
];

// 限额耗尽时 api.github.com 取不到 star，用 2026-11-16 实测快照兜底
const KNOWN_STARS = {
  'morluto/rea': 461960, 'anthropics/skills': 195362, 'DietrichGebert/ponytail': 191457,
  'addyosmani/agent-skills': 117944, 'Leonxlnx/taste-skill': 116238, 'paperclipai/paperclip': 114144,
  'pbakaus/impeccable': 110752, 'nexu-io/open-design': 107762, 'tt-a1i/archify': 96803,
  'career-ops-hq/career-ops': 82792, 'ComposioHQ/awesome-claude-skills': 79583, 'blader/humanizer': 69476,
  'mvanhorn/last30days-skill': 67780, 'coreyhaines31/marketingskills': 60581,
  'hesreallyhim/awesome-claude-code': 58087, 'K-Dense-AI/scientific-agent-skills': 57311,
  'affaan-m/ECC': 303847, 'multica-ai/andrej-karpathy-skills': 233454, 'farion1231/cc-switch': 154621,
  'nextlevelbuilder/ui-ux-pro-max-skill': 0,
};

const outDir = join(HERE, '_data');
mkdirSync(outDir, { recursive: true });

const rows = [];
for (const repo of REPOS) {
  process.stdout.write(`\n>>> ${repo}\n`);
  try {
    const { meta, list } = await collectRemote(repo);
    list.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    writeFileSync(join(outDir, repo.replace('/', '-') + '.json'), JSON.stringify({ meta: { stars: meta.stargazers_count, desc: meta.description, license: meta.license?.spdx_id }, list }, null, 2), 'utf8');
    const avg = Math.round(list.reduce((a, s) => a + s.score, 0) / (list.length || 1));
    const fails = list.filter((s) => s.fail > 0);
    const clean = list.filter((s) => !s.fail && !s.warn).length;
    const stars = meta.stargazers_count ?? KNOWN_STARS[repo] ?? null;
    if (!list.length) {
      rows.push({ repo, stars, n: 0, avg: 0, failList: [], fails: 0, clean: 0, worst: null, all: [], noSkill: true });
      console.log('  该仓库不含 SKILL.md（是 awesome 列表，不是技能包）');
      continue;
    }
    rows.push({ repo, stars, n: list.length, avg, failList: fails, fails: fails.length, clean, worst: list[0], all: list });
    console.log(`  ${list.length} 个技能  平均 ${avg} 分  硬伤 ${fails.length}  零问题 ${clean}  ★${stars ?? '?'}`);
    for (const s of fails) console.log(`   ✗ ${s.name} ${s.score}分 — ${s.issues.filter((i) => i[0] === 'fail').map((i) => i[2]).join('；')}`);
  } catch (e) {
    console.log(`  跳过：${String(e.message).split('\n')[0].slice(0, 140)}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

rows.sort((a, b) => b.avg - a.avg || b.n - a.n);
const L = ['# GitHub 技能仓库体检榜', '',
  `生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC　工具：skill-lint.mjs`, '',
  `合计体检 **${rows.reduce((a, r) => a + r.n, 0)}** 个技能，来自 **${rows.filter((r) => r.n).length}** 个仓库。`, '',
  '| 仓库 | ★ | 技能数 | 平均分 | 硬伤 | 零问题 |', '|---|---:|---:|---:|---:|---:|',
  ...rows.map((r) => (r.noSkill
    ? `| ${r.repo} | ${r.stars ?? '?'} | — | — | — | — |`
    : `| ${r.repo} | ${r.stars ?? '?'} | ${r.n} | ${r.avg} | ${r.fails} | ${r.clean} |`))];
L.push('', '（"—" 表示该仓库是 awesome 列表，本身不含 SKILL.md）');

const hard = rows.flatMap((r) => r.failList.map((s) => ({ repo: r.repo, s })));
L.push('', '## 硬伤清单（违反官方规范，会导致技能加载不全或完全不生效）', '');
if (!hard.length) L.push('（无）');
for (const { repo, s } of hard) {
  L.push(`- **${repo} / ${s.name}**（${s.score} 分）`);
  for (const [, id, msg] of s.issues.filter((i) => i[0] === 'fail')) L.push(`  - \`${id}\`：${msg}`);
}

const COMMON = new Map();
for (const r of rows) for (const s of r.all) for (const [, id] of s.issues) COMMON.set(id, (COMMON.get(id) || 0) + 1);
const totalSkills = rows.reduce((a, r) => a + r.n, 0);
L.push('', '## 最常见的问题（按命中技能数排序）', '', '| 规则 | 命中技能 | 占比 |', '|---|---:|---:|');
for (const [id, n] of [...COMMON.entries()].sort((a, b) => b[1] - a[1])) {
  L.push(`| ${id} | ${n} / ${totalSkills} | ${Math.round((n / totalSkills) * 100)}% |`);
}

writeFileSync(join(outDir, 'leaderboard.md'), L.join('\n'), 'utf8');
console.log(`\n共 ${totalSkills} 个技能。已写 _data/leaderboard.md`);
