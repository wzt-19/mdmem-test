/**
 * terms.mjs —— 词元化 / 同义组 / 标签归一
 *
 * 这套口径**移植自 memory-eternal 的 vault.js**（生产验证过的检索内核），
 * 移植时逐行核对原文，未凭记忆重写。对应原文位置：
 *   queryTerms            → vault.js L127
 *   isContentTerm/FUNC_CHARS → L857-866
 *   indexTokensForSearch  → L884
 *   DEFAULT_SYNONYM_GROUPS/synonymMap/conceptHit → L1039-1090
 *   TAG_ALIAS_BUILTIN / TAG_DROP_BUILTIN / tagTables → L150-238
 *
 * 与原版的唯一区别：原版把别名表/同义组存在 `~/.dsh/`，这里改为**跟着库走**
 * （`<root>/synonyms.json`、`<root>/tags.json`），因为这是给 bot 用的独立库。
 */

import fs from 'node:fs'
import path from 'node:path'

// ─────────────────────────── 查询词元 ───────────────────────────
/** CJK 感知查询词：整词 + 中文字符 bigram。（vault.js L127 同口径） */
export function queryTerms(query) {
  const tokens = new Set(String(query).split(/[^\w\u4e00-\u9fff]+/).filter(Boolean))
  for (let i = 0; i < query.length - 1; i++) {
    const c1 = query[i]
    const c2 = query[i + 1]
    if (/[\u4e00-\u9fff]/.test(c1) && /[\u4e00-\u9fff]/.test(c2)) tokens.add(c1 + c2)
  }
  return tokens
}

/** 功能字：bigram 任一位落在其中即视为「功能词片段」，不计入实词证据。 */
const FUNC_CHARS = new Set('的了是在有和与就都也还把这那哪个该什怎吗呢吧很更最太到被让给'.split(''))

/** 是否算「实词」：不含功能字；单个汉字不算。（vault.js L860 同口径） */
export function isContentTerm(term) {
  const t = String(term)
  if (!t) return false
  if (t.length === 1) return !/[\u4e00-\u9fff]/.test(t)
  for (const ch of t) if (FUNC_CHARS.has(ch)) return false
  return true
}

/**
 * 切索引词元：中文 bigram + 西文词元的**全部后缀**（查询侧用前缀匹配 = 子串语义）。
 * 原文见 vault.js L884。
 */
export function indexTokensForSearch(text) {
  const out = []
  for (const seg of String(text).split(/([a-zA-Z0-9_]+)/)) {
    if (seg === '') continue
    if (/^[a-zA-Z0-9_]+$/.test(seg)) {
      const low = seg.toLowerCase()
      for (let i = 0; i < low.length; i++) out.push(low.slice(i))
      continue
    }
    const cjk = seg.replace(/\s+/gu, '')
    if (cjk.length === 1) out.push(cjk)
    else for (let i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2))
  }
  return out
}

// ─────────────────────────── 同义组 ───────────────────────────
/**
 * 「换个说法问就搜不到」的根治：把「命中一个词元」升级为「命中一个同义组」——
 * 组里任一成员出现在文本中就算该词元命中。**分母不变**，覆盖率与闸门语义不变。
 * （原文与定值依据见 vault.js L1029-1055）
 */
export const DEFAULT_SYNONYM_GROUPS = [
  ['窗口', '会话', '界面'],
  ['反应', '响应', '返回', '回应'],
  ['卡死', '卡住', '吊死', '假死', '挂起', '死锁'],
  ['删除', '删掉', '移除', '清理'],
  ['找不到', '搜不到', '查不到', '召回'],
  ['报错', '异常', '错误', '失败'],
  ['配置', '设置', '参数'],
  ['插件', '扩展', '模块'],
  ['写卡', '存卡', '落库', '入库'],
  ['检索', '搜索', '查找', '查询'],
  ['闸门', '门槛', '阈值'],
  ['排序', '重排', '排名'],
  ['通道', '链路', '通路'],
  ['进程', '程序', '后台'],
  ['记事', '记忆', '知识库', '卡库'],
]

// ─────────────────────────── 标签归一 ───────────────────────────
/**
 * 为什么必须做：权重来自 IDF（df 越小越强），标签一分裂 IDF 就被欺骗
 * （实测：`DSH` 11 次 / `dsh` 1 次被当两个标签，后者被误判成「稀有·强关联」）。
 * 原文见 vault.js L150-177。
 */
const TAG_ALIAS_BUILTIN = {
  dsh: 'DSH',
  windows: 'Windows',
  sqlite: 'SQLite',
  'dsh-engram': 'engram',
  'dsh-computer-use': 'computer-use',
  plugin: '插件',
  dsh插件: '插件',
  踩坑教训: '踩坑',
  安装踩坑: '踩坑',
  用户偏好: '偏好',
  纪律: '工作纪律',
  实测结论: '实测',
}

/**
 * 垃圾标签黑名单：camelCase 变量名 / ALL_CAPS 常量 / 纯通用英文词。
 * 它们几乎总 df=1 → 拿到最高 IDF，一旦查询里正好含该词就会给无关记录错误加权。
 * 刻意不收能当检索词的技术专名（SQLite / FTS5 / MAX_PATH …）。
 * 原文见 vault.js L191-195。
 */
const TAG_DROP_BUILTIN = new Set([
  'allowbuilds', 'unrun', 'bundles', 'pendingcalls', 'approved_total',
  'raw', 'synthetic_events', 'temp', 'profile', 'setsystemcursor',
  'win32', 'pending', 'debug', 'test',
])

// ─────────────────────────── 表加载（按 mtime 热失效） ───────────────────────────
const cache = { synonyms: { key: '', map: new Map() }, tags: { key: '', map: new Map(), drops: new Set() } }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function mtimeOf(file) {
  try { return String(fs.statSync(file).mtimeMs) } catch { return '' }
}

/** 词元 → 同义组（含自身）。`<root>/synonyms.json` 存在则覆盖内置；文件改动按 mtime 热生效。 */
export function synonymMap(root) {
  const file = path.join(root, 'synonyms.json')
  const key = file + '|' + mtimeOf(file)
  if (cache.synonyms.key === key) return cache.synonyms.map
  let groups = DEFAULT_SYNONYM_GROUPS
  const raw = fs.existsSync(file) ? readJson(file) : null
  if (raw) {
    const g = Array.isArray(raw) ? raw : raw.groups
    if (Array.isArray(g) && g.length > 0) {
      groups = g.filter((x) => Array.isArray(x) && x.length > 1)
    }
  }
  const map = new Map()
  for (const g of groups) {
    const lower = g.map((x) => String(x).toLowerCase()).filter((x) => x !== '')
    for (const w of lower) map.set(w, lower)
  }
  cache.synonyms = { key, map }
  return map
}

/** 标签别名表 + 黑名单。`<root>/tags.json` 的 { aliases:{}, drops:[] } 覆盖内置。 */
export function tagTables(root) {
  const file = path.join(root, 'tags.json')
  const key = file + '|' + mtimeOf(file)
  if (cache.tags.key === key) return cache.tags
  const aliases = new Map(Object.entries(TAG_ALIAS_BUILTIN))
  const drops = new Set(TAG_DROP_BUILTIN)
  const raw = fs.existsSync(file) ? readJson(file) : null
  if (raw?.aliases && typeof raw.aliases === 'object') {
    for (const [k, v] of Object.entries(raw.aliases)) aliases.set(String(k).toLowerCase(), String(v))
  }
  if (Array.isArray(raw?.drops)) for (const d of raw.drops) drops.add(String(d).toLowerCase())
  cache.tags = { key, map: aliases, drops }
  return cache.tags
}

/** 单个标签归一：折叠大小写/空白 → 查别名表 → 查黑名单（命中返回空串=丢弃）。 */
export function canonicalTag(root, tag) {
  const t = String(tag ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  const lower = t.toLowerCase()
  if (tagTables(root).drops.has(lower)) return ''
  return tagTables(root).map.get(lower) ?? t
}

/** 一串标签归一 + 去重（保持首次出现顺序）。 */
export function canonicalTags(root, tags) {
  const out = []
  const seen = new Set()
  for (const t of tags || []) {
    const c = canonicalTag(root, t)
    if (!c) continue
    const k = c.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

/**
 * 概念命中（用**已经取好**的同义组表）。
 *
 * ★ 热路径必须用这个：`synonymMap(root)` 为了「改完热生效」每次都 `statSync` 一下那个 json，
 *   而打分循环是「每条目 × 每词元」都调一次 —— 1000 条目 × 9 词元 = 9000 次 statSync，
 *   实测把单次查询拖到 312 ms。改成**每次 search 只取一次表**再传进来，这个开销就没了。
 */
export function conceptHitWith(synMap, haystack, term) {
  if (haystack.includes(term)) return true
  const g = synMap.get(term)
  if (g === undefined) return false
  for (const w of g) if (haystack.includes(w)) return true
  return false
}

/** 概念命中：词元自身命中，或其同义组任一成员命中。（vault.js L1084 同口径） */
export function conceptHit(root, haystack, term) {
  return conceptHitWith(synonymMap(root), haystack, term)
}
