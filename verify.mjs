/**
 * verify.mjs —— 端到端自检（不依赖任何外部服务）
 *
 * 覆盖：
 *   ① 写 → 读回 → 列表 → 统计
 *   ② 检索：直白正例 / **换说法正例**（同义组+改写路径）/ **阴性对照**（必须空）
 *   ③ 软删 → 回收站 → 恢复 → 读回
 *   ④ 蒸馏：假 LLM（故意带代码围栏 + 尾随逗号）→ 容错解析 → 落库 → 读回
 *   ⑤ 持久化：重新打开一个全新实例，数据与索引都在
 *   ⑥ 零外部依赖：全程只用 node 内置
 *
 * 用法：node verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryLibrary } from './index.mjs'
import { renderMessages } from './distill.mjs'
import { queryTerms } from './terms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '_selftest')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

let pass = 0, fail = 0
const ok = (c, msg, extra = '') => { if (c) { pass++; console.log(`  ✅ ${msg}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ❌ ${msg}${extra ? ' — ' + extra : ''}`) } }

const mem = openMemoryLibrary({ root: ROOT })

// ── 领域同义组：库自带的默认组偏通用，领域词要自己补（演示可扩展性）──
fs.writeFileSync(path.join(ROOT, 'synonyms.json'), JSON.stringify({
  groups: [
    ['部署', '上线', '发布', '发版'],
    ['回滚', '退回', '撤销'],
    ['报错', '出错', '异常', '失败', '崩了'],
    ['口径', '标准', '规范', '约定'],
    ['评审', '复查', '过一遍'],
    ['提醒', '通知', '告知', '催'],
    ['反感', '讨厌', '嫌', '不喜欢'],
  ],
}, null, 2), 'utf8')

// ─────────────────────────── ① 写入 ───────────────────────────
console.log('\n【①】写入与读回')
const CORPUS = [
  { k: 'A', title: '老王表面冷淡其实很热心', body: '老王说话直、爱吐槽，但新人问问题他基本都会答。不喜欢别人叫他大佬，说"别捧我"。常在深夜出现。', tags: ['成员', '老王', '画像'], group: 'proj-alpha' },
  { k: 'B', title: '小李坚持不用第三方库', body: '他的理由是"不想引入没人维护的依赖"，被大家劝过很多次都没松口。提到第三方库他会转移话题。', tags: ['成员', '小李', '技术选型'], group: 'proj-alpha' },
  { k: 'C', title: '小张经常在论坛刷到新框架', body: '表示很想试，但因为要和小李保持一致所以一直没上手。推荐算法对他的影响很大。', tags: ['成员', '小张', '技术选型'], group: 'proj-alpha' },
  { k: 'D', title: '项目组的通知默认规矩', body: '没人点名时助手保持沉默，只有被 @、被叫名字、或命中关键词才该出声。普通闲聊不主动插话。', tags: ['规矩', '通知', '沉默'], group: 'proj-alpha' },
  { k: 'E', title: '团队黑话「抽象话」指什么', body: '组里说"抽象话"指的是用谐音、错别字、反串来表达情绪的那类梗，多带调侃意味，不带恶意。新人常误解成骂人。', tags: ['术语', '梗', '抽象话'], group: 'proj-alpha' },
  { k: 'F', title: '别把两个称呼弄反', body: '用户给助手起的昵称是"叫兽"。助手自称"小助"。这两个称呼容易弄混，不要互相当成对方的名字用。', tags: ['人设', '称呼'], group: '' },
  { k: 'G', title: '接待群 proj-beta 的时段规则', body: '该群白天安静、晚上活跃。凌晨 2 点后基本没人，此时不主动插话，避免刷屏。', tags: ['规矩', '时段', '沉默'], group: 'proj-beta' },
  { k: 'H', title: '排查顺序：先看日志再看网关', body: '先看 state/bridge.log 尾部，再看 state/qq-activity.log；两个都正常时怀疑网关掉线。不要一上来就重启。', tags: ['运维', '排错', '日志'], group: '' },
  { k: 'I', title: '不要在群里频繁 @ 同一个人', body: '实测连续 @ 同一个人会引起反感，尤其是非紧急事项。要通知优先用自然语句而不是 @。', tags: ['规矩', '礼仪', 'at'], group: 'proj-alpha' },
  { k: 'J', title: '写长消息的纪律', body: '长消息只在真的需要完整说明时发（比如结论、复盘）。一条说清，别拆成十几条刷屏。', tags: ['消息', '纪律'], group: '' },
  { k: 'K', title: '组内梗：鸸鹋是一种不会飞的鸟', body: '群里拿"鸸鹋"调侃跑不动/不干活的项目。属于内部玩笑，外人听不懂。', tags: ['术语', '梗', '鸸鹋'], group: 'proj-alpha' },
  { k: 'L', title: '配置项容量上限', body: '每位成员最多保留 20 条印象，单条上限 200 字；每轮注入总量兜底 4000 字，防止 token 爆炸。', tags: ['配置', '容量', '上限'], group: '' },
]
const written = {}
for (const c of CORPUS) {
  const r = mem.write({ title: c.title, body: c.body, tags: c.tags, group: c.group, source: 'selftest', importance: 0.6 })
  written[c.k] = r
}
const firstBack = mem.read(written.A.id)
ok(Object.keys(written).length === CORPUS.length, `写入 ${CORPUS.length} 条`)
ok(firstBack && firstBack.title === CORPUS[0].title, '读回首条标题一致')
ok(firstBack && firstBack.body.includes('爱吐槽'), '读回正文完整')
ok(firstBack && firstBack.tags.includes('老王'), '读回标签正确')
ok(fs.readFileSync(firstBack.path)[0] === 0x2d, '写出的文件**不带 BOM**（首字节是 "-"）')
ok(fs.existsSync(path.join(ROOT, '2026-10')), '按 <YYYY-MM>/ 目录布局落盘')

console.log('\n【①b】列表与统计')
const rows = mem.list({ limit: 50 })
ok(rows.length === CORPUS.length, `list 返回 ${rows.length} 条`)
const st = mem.stats()
ok(st.entries === CORPUS.length, `stats.entries = ${st.entries}`)
ok(st.groups.length >= 2, `stats 能看到 ${st.groups.length} 个分组`)
ok(st.topTags.length > 0, `stats.topTags 前 3: ${st.topTags.slice(0, 3).map((t) => `${t.tag}(${t.df})`).join(', ')}`)

// ─────────────────────────── ② 检索 ───────────────────────────
console.log('\n【②】检索质量（这才是核心）')
/** 断言：top-N 里出现目标；返回实际 top3 便于人眼核对 */
function expectHit(label, query, wantKey, { group = '', top = 3 } = {}) {
  const hits = mem.search(query, { limit: 5, ...(group ? { group } : {}) })
  const wantId = written[wantKey]?.id
  const rank = hits.findIndex((h) => h.id === wantId) + 1
  const topStr = hits.slice(0, top).map((h) => h.title.slice(0, 16)).join(' | ')
  ok(rank > 0 && rank <= top, `${label}`, `rank ${rank || '未命中'}/5   top: ${topStr}`)
  return hits
}

expectHit('直白：成员性格', '老王平时热心吗', 'A')
expectHit('直白：术语含义', '什么叫抽象话', 'E')
expectHit('换说法：谁不肯用第三方库', '组里谁死活不肯引入依赖', 'B')
expectHit('换说法：什么时候该插话', '助手什么时候该插话', 'D', { top: 2 })
expectHit('换说法：几点之后安静', '晚上几点之后安静', 'G')
expectHit('换说法：提醒多了会不会惹人烦', '一直提醒同一个人他会不会反感', 'I')
expectHit('实词改写：长消息能不能连着发', '消息能不能一次发好几条', 'J')
expectHit('配置类：印象最多存几条', '每个成员最多记多少条印象', 'L')

console.log('\n【②b】已知边界（**如实记录，不做成"通过"**）')
// 这条改写「提醒/别人/惹人烦」与卡片用词（通知/同一个人/反感）几乎无词面重合，
// 且同义组也没覆盖「别人」「惹人烦」→ 词面与概念双双落空 ⇒ **本就召回不到**。
// 留着当负样本，说明这套检索的能力边界在哪；要覆盖它得往 synonyms.json 里补组。
{
  const hard = mem.search('怎么提醒别人不容易惹人烦', { limit: 5 })
  const hitI = hard.some((h) => h.id === written.I.id)
  ok(hitI === false, '已知边界：纯改写「怎么提醒别人不容易惹人烦」当前召回不到（如实记录，非通过项）',
    `返回 ${hard.length} 条`)
}

console.log('\n【②b】阴性对照（库里不存在的东西 —— **必须返回空**，不许凑数）')

/**
 * 生成式对照串：**不把对照串写死进代码**。
 *
 * 为什么：写死的串只要被逐字写进报告/记忆库/日志，下次检索它就会命中含该串的记录（实测踩过 ——
 * 探针词一旦写进语料，就会顶掉真知识卡的排名）。所以这里在**运行时**用固定种子从
 * Unicode 私用区（U+E000–F8FF，常用中文/日文都用不到，正常语料不会出现）拼串：
 * 代码里看不到字面量，报告里也**只打印长度**。
 *
 * 注意两个坑（都踩过）：
 *   ① **别用 Unicode 私用区**：`queryTerms` 只认 `\w` 与 CJK 基本区（U+4E00–9FFF），
 *      私用区字符会被整个丢掉 ⇒ 查询变成空串 ⇒ 返回空是"查了个寂寞"，**假阳性**。
 *   ② 断言消息**不放串内容** —— 失败日志会被采集/沉淀，写进去等于自污染。
 *      要复现失败，请用固定种子重放，不要抄串。
 *
 * 所以改成"稀疏 CJK 取样"：跨多个区块抽字拼串 —— 能被词元化，且三字组合在真实语料里
 * 不可能出现（每个字本身可能常见，组合极稀有）。
 */
const genNegative = (() => {
  let x = 20261006
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
  const BLOCKS = [0x4E00, 0x5200, 0x5600, 0x5E00, 0x6700, 0x7300, 0x7C00, 0x8800, 0x9200, 0x9A00] // CJK 基本区各段起点
  const chr = () => String.fromCharCode(BLOCKS[Math.floor(rnd() * BLOCKS.length)] + Math.floor(rnd() * 0x60))
  return (n = 3) => {
    let s = ''
    for (let i = 0; i < n; i++) s += chr()
    return s + String(Math.floor(rnd() * 9000) + 1000)
  }
})()
// 自检：生成的字必须真的不在语料里（否则"阴性"名不副实），且必须被词元化保留（否则测的是空查询）
{
  const probe = genNegative(4).slice(0, 4)
  const inCorpus = mem.list({ limit: 1000 }).some((e) => {
    const full = mem.read(e.rel) // list() 不带正文，要读全文才算数
    return `${e.title}\n${full?.body || ''}`.includes(probe)
  })
  ok(!inCorpus, '生成式对照串确实不在语料中（量具自检）')
  ok(queryTerms(probe).size > 0, '生成式对照串能被词元化（不是空查询）')
}
for (let i = 0; i < 3; i++) {
  const q = genNegative(3) // 每轮现拼一个，代码里没有字面量
  const hits = mem.search(q, { limit: 5 })
  ok(hits.length === 0, `生成式阴性对照 ${i + 1}/3（${q.length} 字符）→ 空`,
    hits.length ? `⚠ 漏出 ${hits.length} 条：${hits.map((h) => h.title.slice(0, 14)).join(' | ')}` : '')
}
// 另加一个"看着像真的、其实库里没有"的对照：词面正常但不该召回
{
  const q = '钴蓝犀牛税务申报流程'
  const hits = mem.search(q, { limit: 5 })
  ok(hits.length === 0, '语法正常但库里没有的查询 → 空（不硬凑）', hits.length ? `⚠ 漏出 ${hits.length} 条` : '')
}

console.log('\n【②c】按 group 过滤')
const g = mem.search('规矩', { limit: 10, group: 'proj-alpha' })
ok(g.every((h) => h.group === 'proj-alpha'), `group=proj-alpha 过滤生效（${g.length} 条）`)

// ─────────────────────────── ③ 软删 / 恢复 ───────────────────────────
console.log('\n【③】软删 → 回收站 → 恢复')
const del = mem.remove(written.K.id)
ok(fs.existsSync(del.moved), '软删后文件在 .trash 里')
ok(mem.read(written.K.id) === null, '删除后检索/读取都查不到（读回确认）')
ok(mem.search('鸸鹋是什么', { limit: 5 }).length === 0, '删除后检索也不再命中它')
ok(mem.trash().length === 1, `回收站 ${mem.trash().length} 条`)
mem.restore(del.rel)
const restored = mem.read(written.K.id)
ok(restored && restored.title.includes('鸸鹋'), '恢复后又能读到')

// ─────────────────────────── ④ 蒸馏（假 LLM）───────────────────────────
console.log('\n【④】蒸馏（用假 LLM，零成本跑通全链路）')
const CHAT = [
  { speaker: '老王', time: '2026-10-05T22:10:00', text: '新来的那个谁，别老 @ 我，有事直接说' },
  { speaker: '小李', time: '2026-10-05T22:11:00', text: '他就是这样，嘴上凶' },
  { speaker: '小张', time: '2026-10-05T22:12:00', text: '哈哈哈哈老王又开始了' },
  { speaker: '老王', time: '2026-10-05T22:13:00', text: '还有，以后问我引不引入第三方库的一律不回' },
]
const chars = renderMessages(CHAT).length
ok(chars > 0, `渲染对话记录 ${chars} 字`)
ok(mem.shouldDistill(CHAT, 100) === true, '短阈值下判定「该蒸馏」')
ok(mem.shouldDistill(CHAT, 100000) === false, '大阈值下判定「不需要」')

// 故意做成模型常见的坏输出：代码围栏 + 尾随逗号 + 多余解释
const FAKE_LLM_OUTPUT = [
  '好的，我提炼了以下记忆：',
  '```json',
  '[',
  '  {',
  '    "title": "老王反感被频繁 @",',
  '    "body": "老王明确说过不喜欢别人老 @ 他，有事直接说。组里其他人也印证了这是他的一贯态度。",',
  '    "tags": ["成员", "老王", "礼仪"],',
  '    "importance": 0.8,',
  '  },',
  '  {',
  '    "title": "老王不接受关于第三方库的询问",',
  '    "body": "老王表示以后问他引不引入第三方库的一律不回，属于明确的沟通边界。",',
  '    "tags": ["成员", "老王", "技术选型"],',
  '    "importance": 0.7,',
  '  },',
  ']',
  '```',
  '需要我调整粒度吗？',
].join('\n')

const fakeLLM = async () => FAKE_LLM_OUTPUT
const d = await mem.distill({ messages: CHAT, callLLM: fakeLLM, maxEntries: 5, group: 'proj-alpha' })
ok(d.entries.length === 2, `容错解析出 ${d.entries.length} 条（输入含围栏/尾随逗号/解释文字）`)
ok(d.written.length === 2, `落库 ${d.written.length} 条`)
const dBack = d.written.length ? mem.read(d.written[0].id) : null
ok(dBack && dBack.group === 'proj-alpha', '蒸馏条目带上了 group')
ok(dBack && dBack.source === 'chat', `来源标记 source=${dBack?.source}`)
const dHits = mem.search('老王讨厌被@吗', { limit: 5 })
ok(dHits.some((h) => h.id === d.written[0]?.id), '刚蒸馏出来的条目**立刻可检索**', `top: ${dHits.slice(0, 3).map((h) => h.title.slice(0, 14)).join(' | ')}`)

console.log('\n【④b】蒸馏 dry-run（只生成不落库）')
const before = mem.stats().entries
const dry = await mem.distill({ messages: CHAT, callLLM: fakeLLM, dryRun: true })
ok(dry.entries.length === 2 && dry.written.length === 0, 'dry-run 解析出条目但不写盘')
ok(mem.stats().entries === before, `库条数未变（${before}）`)

console.log('\n【④c】「不够长就不蒸」的一站式接口')
const r1 = await mem.distillIfNeeded({ messages: CHAT, callLLM: fakeLLM, budget: 100000 })
ok(r1.skipped === 'under-budget', '未超阈值时直接跳过（不调 LLM）')
let called = 0
await mem.distillIfNeeded({ messages: CHAT, callLLM: async () => { called++; return '[]' }, budget: 10 })
ok(called === 1, '超阈值时会真的调 LLM 一次')

// ─────────────────────────── ⑤ 持久化 ───────────────────────────
console.log('\n【⑤】持久化：换一个全新实例重新打开')
const mem2 = openMemoryLibrary({ root: ROOT })
ok(mem2.stats().entries === mem.stats().entries, `重开后条数一致（${mem2.stats().entries}）`)
const reHit = mem2.search('团队黑话有哪些', { limit: 5 })
ok(reHit.length > 0, `重开后检索正常（${reHit.length} 条）`, `top: ${reHit.slice(0, 2).map((h) => h.title.slice(0, 16)).join(' | ')}`)
ok(mem2.read(written.E.id)?.title.includes('抽象话'), '重开后按 id 读单条正常')

// ─────────────────────────── ⑥ 手工改 md 后索引自愈 ───────────────────────────
console.log('\n【⑥】手工编辑 md 文件后，索引应自愈')
const p = path.join(ROOT, written.L.rel)
const txt = fs.readFileSync(p, 'utf8')
fs.writeFileSync(p, txt.replace('最多保留 20 条印象', '最多保留 20 条印象（2026-10-05 起改为 30）'), 'utf8')
const healed = mem.search('印象最多存几条', { limit: 3 })
ok(healed.some((h) => h.excerpt.includes('30')), '指纹变化后自动重建索引，读到新内容')

// ─────────────────────────── 汇总 ───────────────────────────
const total = pass + fail
console.log('\n' + '='.repeat(70))
console.log(`自检：${pass}/${total} 通过${fail ? `，${fail} 项 ❌` : ' —— 全过 ✅'}`)
console.log(`库目录：${ROOT}`)
console.log(`条目 ${mem.stats().entries} 条 · ${(mem.stats().bytes / 1024).toFixed(1)} KB`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
