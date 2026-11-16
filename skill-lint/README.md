# Agent Skills 体检 · skill-lint

> 你装了 30 个 AI 技能，可能一半从没被调用过——因为它们没写"什么时候该用我"。

给 [Agent Skills](https://agentskills.io/specification)（`SKILL.md`）做体检的命令行工具。**单文件、零依赖、离线可跑**，既能查本地技能目录，也能直接查 GitHub 仓库。

```
$ node skill-lint.mjs examples/before

体检 1 个技能  平均 82 分   完全合格 0 个   有硬伤 0 个

pdf-merge  B 82分  148字 / desc 294
   ! no-trigger   description 里没有明确的触发条件（如 "当用户…时使用" / "Use when…"），容易被模型忽略
   ! broken-ref   2 处引用的文件不存在：scripts/merge.py、references/api.md
   ! no-boundary  正文没有"什么时候不该用"的边界，容易被过度触发
```

改完之后：

```
$ node skill-lint.mjs examples/after

体检 1 个技能  平均 100 分   完全合格 1 个   有硬伤 0 个

pdf-merge  A 100分  317字 / desc 135
   ✓ 没有发现问题
```

## 为什么需要它

Agent Skills 的规范只有两个必填字段，但这两个字段决定了技能**会不会被加载**：

| 字段 | 约束 | 违反的后果 |
|---|---|---|
| `name` | 1–64 字符，小写字母/数字/连字符，**必须与父目录名一致** | 客户端可能加载失败 |
| `description` | 1–1024 字符，必须同时说清"做什么"和"何时用" | 超长被截断；没有触发词则永远不被选中 |

规范原文：<https://agentskills.io/specification>

实际体检下来，最常见的问题不是格式错误，而是 **没写"什么时候不该用"** 和 **没写触发词**——技能装上了，但模型永远不选它。

## 用法

```bash
# 体检本地技能目录（递归找所有 SKILL.md）
node skill-lint.mjs "C:\Users\你\.dsh\skills"

# 体检单个技能
node skill-lint.mjs ./my-skill

# 体检 GitHub 仓库（owner/name）
node skill-lint.mjs --repo anthropics/skills

# 输出 Markdown 报告 / JSON
node skill-lint.mjs --repo addyosmani/agent-skills --md > report.md
node skill-lint.mjs --repo anthropics/skills --json
```

也可以全局安装后直接用：

```bash
npm i -g .
skill-lint --repo anthropics/skills
```

## 检查项

| 规则 | 级别 | 说明 |
|---|---|---|
| `frontmatter` | 硬伤 | 开头没有合法 `---` 块 |
| `name` / `description` | 硬伤 | 缺必填字段 |
| `empty-body` | 硬伤 | 只有 frontmatter，没有正文 |
| `desc-long` | 硬伤 | `description` 超过 1024 字符（官方硬上限） |
| `name-format` | 提醒 | 不符合小写连字符格式 |
| `name-dir` | 提醒 | `name` 与文件夹名不一致 |
| `desc-short` | 提醒 | `< 40` 字，判断不了何时加载 |
| `desc-bloat` | 提醒 | `> 700` 字，触发精度下降 |
| `no-trigger` | 提醒 | `description` 里没有触发条件 |
| `no-boundary` | 提醒 | 没有"何时不该用"的边界（也认 `For X, see Y` 这种路由句） |
| `body-bloat` | 提醒 | 正文 `> 6000` 词 |
| `broken-ref` | 提醒 | 引用了不存在的资料文件 |

评分：`100 - 硬伤×18 - 提醒×6`，下限 0。等级 A≥90 / B≥78 / C≥62 / D≥45 / E。

## 断链检查为什么不做成"全量检查"

正文里写的 `src/utils/format.ts` 是**举例用的伪路径**，不是断链。所以只检查技能自带资料目录里的引用：

```
references/  scripts/  assets/  templates/  examples/  evals/  docs/  core/  shared/ ...
```

早期版本把示例路径全报成断链，噪音大到不可用。

## 远程读取

- **首选** `codeload.github.com/<repo>/tar.gz/refs/heads/<branch>`：整包下载 + 自写 tar 解析，**不消耗 API 限额**。
- **退路** `api.github.com` contents API：未认证限额 60 次/小时/IP，设了 `GH_TOKEN` 提到 5000/小时。
- ⚠️ 限额耗尽时 GitHub 会返回 **HTTP 200 但正文是限流 JSON**，必须显式识别，否则会把错误信息当成技能内容去评分（这个坑踩过）。
- ⚠️ `raw.githubusercontent.com` 在部分网络环境不通，本工具不依赖它。

## 批量体检

```bash
node _batch.mjs   # 结果写 _data/<owner>-<repo>.json 与 _data/leaderboard.md
```

> 若你的环境禁止 `child_process` spawn（某些 Windows 沙箱会 `EPERM`），`_batch.mjs` 采用直接 `import` 函数的方式规避。

## 已知限制

- 只按规范做静态检查，不测技能的实际触发准确率——那要真跑模型。
- `no-boundary` / `no-trigger` 是关键词启发式，会有漏判和误判，仅作参考。
- tar 超过 80MB 的仓库不整包下载，会退到 contents API。

## 数据快照（2026-11-16）

9 个仓库共 **1155 个技能**，见 [`_data/leaderboard.md`](_data/leaderboard.md)。

| 仓库 | ★ | 技能数 | 平均分 | 硬伤 | 零问题 |
|---|---:|---:|---:|---:|---:|
| coreyhaines31/marketingskills | 60581 | 53 | 100 | 0 | 51 |
| blader/humanizer | 69476 | 1 | 100 | 0 | 1 |
| addyosmani/agent-skills | 117944 | 25 | 98 | 0 | 15 |
| K-Dense-AI/scientific-agent-skills | 57311 | 177 | 95 | 0 | 68 |
| mvanhorn/last30days-skill | 67780 | 1 | 94 | 0 | 0 |
| multica-ai/andrej-karpathy-skills | 233454 | 1 | 94 | 0 | 0 |
| anthropics/skills | 195362 | 20 | 92 | **1** | 6 |
| nextlevelbuilder/ui-ux-pro-max-skill | — | 13 | 88 | 0 | 0 |
| ComposioHQ/awesome-claude-skills | 79583 | 864 | 87 | 0 | 1 |

唯一一个格式硬伤：`anthropics/skills` 里的 `claude-api`，`description` 写了 1070 字，**超过官方 1024 上限**，会被客户端截断。

## License

MIT
