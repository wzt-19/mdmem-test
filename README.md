# mdmem-test

**一个记忆 = 一个 markdown 文件。** 零依赖、中文友好、能搜能读能改的轻量记忆库。

给需要长期记忆的程序（AI agent、机器人、个人知识库、脚本）用：
**不需要数据库、不需要向量模型、不需要服务、不需要构建。** 只有 node 内置模块。

```js
import { openMemoryLibrary } from 'mdmem-test'

const mem = openMemoryLibrary({ root: './notes' })
mem.write({ title: '老王不喜欢被频繁 @', body: '有事直接说，别连着 @ 他。', tags: ['礼仪'] })
mem.search('怎么提醒同一个人')      // 换种说法也搜得到
```

每个文件都是这样，人可以直接读、直接改、直接进 git：

```markdown
---
id: 2026-10-06-a1b2c3
title: 老王不喜欢被频繁 @
tags: ["礼仪","成员"]
date: 2026-10-06
---

有事直接说，别连着 @ 他。
```

---

## 为什么不是又一个向量库

| | 向量库 / 数据库 | mdmem-test |
|---|---|---|
| 依赖 | 嵌入模型 + 数据库 + 索引服务 | **0** |
| 数据形态 | 不可读的二进制 / 需查询才可读 | **人能读的 .md**，`cat` 就能看 |
| 手工修正 | 要写脚本或走 API | 用编辑器改文件即可 |
| 版本管理 | 难 diff | `git log` 就是记忆的变更史 |
| 规模上限 | 百万级 | 几千条（再多就该上索引了，见下） |
| 代价 | — | 没有语义泛化：**换个说法全靠字面重合**（见[已知边界](#已知边界)） |

如果你要的是"把成千上万条笔记按语义搜出来"，这东西不适合。
如果你要的是"**几十到几千条必须记得住、还得能看懂能改的记忆**"，它就是为这个场景写的。

## 特性

- **零依赖**：只用 `node:fs` / `node:path` / `node:crypto`。没有 install 后跑不起来的概率。
- **CJK 友好**：中文按双字切分，不需要分词词典；`老王是谁`、`@`、`22GB` 混着写都能搜。
- **检索有闸门**：相关度不够就**返回空**，不凑数。宁缺毋滥，这对喂给模型的记忆尤其重要。
- **软删除**：删除默认进 `.trash/`，可恢复；真要永久删得显式声明。
- **手工改文件即时生效**：按「文件数 + 最新 mtime + 总字节」的指纹惰性重建索引，不用重启。
- **可选蒸馏**：给一段对话 + 一个 LLM，自动提炼成记忆条目落库（LLM 由你注入，不绑定厂商）。
- **不猜目录**：`root` 必须显式给，库不存在就报错 —— 猜错路径的代价是往不该写的地方写数据。

## 快速开始

```bash
npm install mdmem-test          # 或者直接把这个目录拷走用
```

```js
import { openMemoryLibrary } from 'mdmem-test'

const mem = openMemoryLibrary({ root: './notes' })   // 目录不存在会自动创建

// 写
mem.write({
  title: '部署流程：先跑自检再发版',
  body: '发版前必须跑一遍 npm test；跳过自检的那次出过事故。',
  tags: ['流程', '发版'],
})

// 检索（返回按相关度排序的数组）
mem.search('发版前要做什么', { limit: 5 })
// → [{ id, rel, title, tags, score, coverage, matchedTags, excerpt, … }]

// 读单条（id / 相对路径 / 标题都行，支持前缀与模糊）
mem.read('2026-10-06-a1b2c3')

// 列 / 统计 / 软删 / 恢复
mem.list({ limit: 20 })
mem.stats()
mem.remove(key)          // → .trash/（可恢复）
mem.restore(rel)         // 从回收站恢复
```

### 当命令用

```bash
mdmem-test --root ./notes search "发版前要做什么" --limit 5
mdmem-test --root ./notes read "部署流程"
mdmem-test --root ./notes write --title "..." --body "..." --tags 流程,发版
mdmem-test --root ./notes list --limit 20
mdmem-test --root ./notes stats
mdmem-test --root ./notes rm <key>                    # 软删
mdmem-test --root ./notes rm <key> --permanent --yes  # 永久删（必须显式）
mdmem-test --root ./notes trash | restore <rel>
mdmem-test --root ./notes distill --messages chat.json --dry   # 只看提示词
```

`--root` 也可以用环境变量 `MDMEM_ROOT`。**两个都没给会直接报错退出**，不会瞎猜目录。

### 可选：把对话蒸馏成记忆

给一段对话，让模型提炼出值得长期记住的条目：

```js
const mem = openMemoryLibrary({ root: './notes' })
await mem.distillIfNeeded({
  messages: [{ speaker: '老王', text: '别老 @ 我' }, /* … */],
  callLLM: async ({ system, user }) => myLLM(system, user),   // 你自己注入
  budget: 6000,        // 累计超过这么多字符才蒸
})
// → { skipped: 'under-budget' } 或 { entries, written }
```

CLI 内置 OpenAI 兼容适配器：`MDMEM_LLM_BASE` / `MDMEM_LLM_KEY` / `MDMEM_LLM_MODEL`。

## 存储格式

```
<root>/
├─ 2026-10/
│  └─ 老王不喜欢被频繁-@.md
├─ synonyms.json    （可选）领域同义组
├─ tags.json        （可选）标签别名 / 黑名单
├─ feedback.json    （可选）"这条有用"的反馈
└─ .trash/          软删的都在这里，可恢复
```

- frontmatter 用**严格可解析的子集**（字符串 / 数字 / JSON 数组），不引 YAML 依赖
- 文件名保留中文（可读性优先），只清洗 Windows 保留字符
- 写文件**不带 BOM**

## 检索算法

刻意做得能被一眼看完 —— 这样出问题时你能自己定位，而不是靠调参玄学。

| 环节 | 规则 |
|---|---|
| **词元** | 整词 + 中文双字（bigram）。`老王是谁` → `老王` / `王是` / `是谁` |
| **打分** | 整串命中 `+3`；每个词元命中「路径/标题」记 `headWeight`（默认 2），否则记 1 |
| **标签** | 精确等于标签 → `+2×IDF×tagWeight` 且**算主证据**；互相包含 → `+1×IDF`（只打分） |
| **闸门** | `score>0` 且（整串命中 ∥ 精确标签 ∥ 覆盖率≥0.2 且命中≥2 词元 ∥ 改写路径） |
| **改写路径** | 实词命中 ≥2 且覆盖率 ≥0.1 —— 治「二十个G」对「20GB」这类词面对不上 |
| **排序** | score 降序，同分按 mtime 降序 |
| **反馈** | `feedback.json` 里同查询的 useful/irr 各 ±2 分 |

**覆盖率是按「全部词元」算的**，不是按实词算 —— 这点在短查询上很关键：
`太晚了就别插话了吧` 切出 9 个词元，只有 `插话` 命中 → 覆盖率 1/9 = 0.11 < 0.2 → **被拦**。
这是设计意图（不凑数），不是 bug；要召回就换个与语料词面更近的说法，或往 `synonyms.json` 里补同义组。

### 已知边界

如实记录，不粉饰：

- **词面与概念双双落空就召回不到**。查询和记忆里没有任何共同词元、同义组也没覆盖时，返回空。
  这是"宁缺毋滥"的直接代价；要覆盖就补 `synonyms.json`。
- **没有真正的语义检索**。`semantic` 开关是「查询 vs 标题」的字符 bigram Jaccard，不是向量。
- **标签不参与覆盖率**。多关键词查询里若某词只命中标签，不计入覆盖率。
- **全量扫描，没做倒排索引**。几千条是毫秒级；上万条就该加索引了（接口不用变）。

## 性能

`bench-scale.mjs` 实测（单机，写入 + 查询）：

| 条目数 | 批量写入 | 首次查询（含建索引） | 再查（命中缓存） | RSS |
|---|---|---|---|---|
| 50 | 18 ms | 19 ms | **1.3 ms** | 54 MB |
| 200 | 60 ms | 69 ms | **4.5 ms** | 57 MB |
| 500 | 153 ms | 182 ms | **10.1 ms** | 62 MB |
| 1000 | 295 ms | 358 ms | **20.7 ms** | 72 MB |

> 索引按指纹惰性重建：语料不变就一直复用；改了任何一个 md → 下次查询自动重建。
> 所以"首次查询"那个数字只在语料变化后的第一枪出现。

## 扩展点（都是纯 JSON，改完热生效）

| 文件 | 作用 |
|---|---|
| `<root>/synonyms.json` | `{ "groups": [["部署","上线","发版"], …] }` —— **领域词只有你自己知道，务必补** |
| `<root>/tags.json` | `{ "aliases": {"dsh":"DSH"}, "drops": ["camelCaseVar"] }` —— 标签归一与垃圾标签黑名单 |
| `<root>/feedback.json` | `[{ "rel":"…", "query":"…", "useful":true }]` —— 用过的记一笔，同查询加权 |

`synonyms-example.json` 是一份可抄的样例（含"为什么键是词元而不是概念名"的说明）。

## 自检

```bash
node verify.mjs       # 44 项：写读 / 检索质量 / 阴性对照 / 软删恢复 / 蒸馏 / 持久化 / 手工改 md 自愈
node verify-cli.mjs   # 18 项：CLI 全命令 + 安全闸
npm test              # 等价于 verify.mjs
```

两个都退出码 0 才算通过。自检**不依赖任何外部服务**（蒸馏用假 LLM），全程在临时目录里跑。

## 设计取舍（为什么这么简单）

- **宁可少召回，不可乱召回**。记忆是喂给模型的上下文，一条无关记忆的代价比一次搜不到高得多。
- **人能读 > 机器高效**。markdown 文件可以被 `grep`、被 git、被任何编辑器打开 —— 这是它最大的价值。
- **没有的东西比有的东西更贵**。没有索引服务、没有依赖树、没有构建步骤，就没有对应的故障面。
- **调优件不进第一版**。同义组、标签 IDF、反馈反哺都留了扩展点，但默认行为保持可解释。

## License

MIT
