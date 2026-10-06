/**
 * retrieve.mjs —— 检索内核
 *
 * **算法逐行移植自 memory-eternal 的 `search()`（vault.js L1092-1205）**，
 * 那是已经在生产里跑过、并用 mem-probe 基准量化过的实现。移植时保持语义不变：
 *
 *   打分：整串命中=3；每个词元命中 → 命中 head(路径+标题) 记 headWeight、否则记 1
 *   标签：精确等于标签 → +2×IDF×tagWeight 且**算主证据**；互相包含 → +1×IDF×tagWeight（只打分）
 *   闸门：score>0 且 score≥minScore 且（整串命中 ∥ 精确标签 ∥ 覆盖率≥0.2 ∥ 改写路径）
 *   改写路径：实词命中≥2 且 覆盖率≥0.1（专治「二十个G」对「20GB」这类词面对不上）
 *   排序：score 降序，同分按 mtime 降序
 *
 * 与 vault 版的**唯一取舍**：这里不做「倒排索引粗召回」，直接全量精算。
 *   理由：vault 加索引是因为它有 4300 张卡、单查 3.1s；
 *   本库是 bot 记忆（几百~几千条短文），全扫是毫秒级，而全扫 = vault 的 `useIndex:false`
 *   参考路径，**语义上更不容易出错**（粗召回筛错候选是 vault 实测栽过的坑）。
 *   语料超 ~5000 条时再加倒排，接口不变。
 */

import fs from 'node:fs'
import path from 'node:path'
import { canonicalTags, conceptHitWith, isContentTerm, queryTerms, synonymMap } from './terms.mjs'
import { fingerprint, readEntry, scanFiles, shortHash } from './store.mjs'

// ─── 闸门常量 ───
export const MIN_COVERAGE = 0.2          // 主阈值（vault.js L842 定值：正例零损失、阴性 1→0）
export const MIN_CONTENT_TERMS = 2       // 改写路径：至少 2 个实词
export const MIN_COVERAGE_PARAPHRASE = 0.1 // 改写路径的覆盖率下限

/**
 * ★ 绝对命中下限（2026-10-05 移植时补的，**vault 原版没有**）
 *
 * 为什么必须加：`MIN_COVERAGE = 0.2` 是按**长查询**标定的 —— 典型查询 10~30 个词元，
 * 20% 相当于「命中 2~6 个」，松紧合适。但它对**短查询**过松：
 *   实测阴性对照串切出 4 个词元 `zzq / nonexistent / topic / 2026`，
 *   仅 `2026` 一词命中每个文件的路径前缀（`2026-10/…`）⇒ 覆盖率 1/4 = 0.25 ≥ 0.2 ⇒ **放行**，
 *   一条本不该存在的查询漏出了 5 条无关记忆。同理「鸸鹋是什么」在删除目标后，
 *   仅靠别处的「什么」二字就能凑够覆盖率。
 *
 * 规则：走覆盖率路径时，**至少命中 2 个词元**（查询本身只有 1 个词元时降级为 1）。
 * 对长查询无影响（20% × 15 = 3 > 2），只收紧短查询。
 */
const minTermHits = (wantedSize) => Math.min(MIN_CONTENT_TERMS, Math.max(1, wantedSize))

const bigramSet = (s) => {
  const t = String(s).replace(/\s+/gu, '')
  const out = new Set()
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
  for (let i = 0; i < t.length; i++) out.add(t[i])
  return out
}
/** 字符 bigram Jaccard（vault.js L122 同口径）。 */
export function textSimilarity(a, b) {
  const ba = bigramSet(a)
  const bb = bigramSet(b)
  if (!ba.size || !bb.size) return 0
  let inter = 0
  for (const g of ba) if (bb.has(g)) inter++
  return inter / (ba.size + bb.size - inter)
}

// ─────────────────────────── 索引缓存 ───────────────────────────
const cache = new Map() // root -> { fp, entries, tagDf, totalN, builtAt }

function buildIndex(root) {
  const files = scanFiles(root)
  const fp = fingerprint(files)
  const hit = cache.get(root)
  if (hit && hit.fp === fp) return hit

  const entries = []
  for (const f of files) {
    try { entries.push(readEntry(root, f.rel)) } catch { /* 坏文件跳过，不拖垮整个库 */ }
  }
  // ★ 预计算（2026-10-05 性能修复）：把「只跟条目有关、与查询无关」的东西一次算好。
  //   原先在打分循环里每条目都做一次：canonicalTags(→statSync 那个 tags.json)、
  //   `${rel}\n${title}\n${body}`.toLowerCase()。1000 条目 × 每次查询 = 上千次 syscall + 上千次拼接，
  //   实测单查询 312 ms。预计算后这些成本只付一次。
  const tagDf = new Map()
  for (const e of entries) {
    e.tagsCanon = canonicalTags(root, e.tags)
    e.headLc = `${e.rel}\n${e.title}`.toLowerCase()
    e.hayLc = `${e.headLc}\n${e.body}`.toLowerCase()
    for (const t of e.tagsCanon) tagDf.set(t, (tagDf.get(t) || 0) + 1)
  }
  const built = { fp, entries, tagDf, totalN: entries.length || 1, builtAt: Date.now() }
  cache.set(root, built)
  return built
}

/** 丢掉某库的索引缓存（手工改了 md 文件后可显式调用；一般不需要，指纹会自愈）。 */
export function invalidate(root) {
  if (root) cache.delete(root)
  else cache.clear()
}

// ─────────────────────────── 检索 ───────────────────────────
/**
 * @param {string} root  记忆库根目录
 * @param {string} query 查询串
 * @param {object} opts  { limit, minScore, tagWeight, headWeight, semantic, group }
 * @returns {Array} 命中（含 score / coverage / matchedTags / excerpt）
 */
export function search(root, query, opts = {}) {
  const { limit = 20, minScore = 0, tagWeight = 1, headWeight = 2, semantic = false, group = '' } = opts
  const q = String(query || '').trim()
  if (!q) return []

  const idx = buildIndex(root)
  const wanted = queryTerms(q)
  const ql = q.toLowerCase()
  const tagIdf = (t) => Math.log(1 + idx.totalN / (idx.tagDf.get(String(t)) || 1))
  // ★ 同义组表**每次查询只取一次**（取表本身要 statSync 那个 json）
  const syn = synonymMap(root)

  // 语料级反馈（<root>/feedback.json）：形状同 vault，写对/写错的显式信号
  const fb = readFeedback(root)
  const fbBy = new Map()
  for (const f of fb) {
    if (!f.rel) continue
    const fq = String(f.query || '').toLowerCase()
    if (!fq) continue
    const overlap = fq === ql || ql.includes(fq) || fq.includes(ql)
      || queryTerms(f.query).size && [...queryTerms(f.query)].some((t) => wanted.has(t))
    if (!overlap) continue
    const rec = fbBy.get(f.rel) || { useful: 0, irr: 0 }
    if (f.useful) rec.useful += 1; else rec.irr += 1
    fbBy.set(f.rel, rec)
  }

  const out = []
  for (const e of idx.entries) {
    if (group && String(e.group) !== String(group)) continue
    // 标签刻意不混进 haystack：它是加权信号而不是普通子串（vault.js L1131 同口径）
    // head/haystack 与归一化标签都在建索引时预计算好了（见 buildIndex 的注释）
    const head = e.headLc
    const haystack = e.hayLc

    let score = 0
    const fullHit = haystack.includes(ql)
    if (fullHit) score = 3

    let termHits = 0
    let contentHits = 0
    for (const term of wanted) {
      const t = term.toLowerCase()
      if (conceptHitWith(syn, haystack, t)) {
        score += head.includes(t) ? headWeight : 1
        termHits += 1
        if (isContentTerm(term)) contentHits += 1
      }
    }
    const coverage = wanted.size > 0 ? termHits / wanted.size : 0

    const matchedTags = []
    let exactTag = false
    if (tagWeight > 0) {
      for (const tg of e.tagsCanon) {
        const tl = String(tg).toLowerCase()
        if (!tl) continue
        if (tl === ql) { score += 2 * tagIdf(tg) * tagWeight; matchedTags.push(String(tg)); exactTag = true }
        else if (ql.length > 1 && (ql.includes(tl) || tl.includes(ql))) { score += 1 * tagIdf(tg) * tagWeight; matchedTags.push(String(tg)) }
      }
    }
    // 语义加权：**不是真向量**，是「查询 vs 标题」的字符 bigram Jaccard（vault 同款，默认关）
    if (semantic) score += textSimilarity(q, e.title) * 50

    const paraphrase = contentHits >= MIN_CONTENT_TERMS && coverage >= MIN_COVERAGE_PARAPHRASE
    // 主路径必须同时满足「覆盖率达标」**且**「词元命中数达标」—— 见 minTermHits 的注释
    const coverageOk = coverage >= MIN_COVERAGE && termHits >= minTermHits(wanted.size)
    if (!(score > 0 && score >= minScore && (fullHit || exactTag || coverageOk || paraphrase))) continue

    const r = fbBy.get(e.rel)
    if (r) score += r.useful * 2 - r.irr * 2

    out.push({
      id: e.id,
      rel: e.rel,
      title: e.title,
      tags: e.tags,
      group: e.group,
      date: e.date,
      score,
      coverage,
      matchedTags,
      excerpt: e.body.replace(/\s+/g, ' ').trim().slice(0, 200),
      mtime: e.mtime,
    })
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return out.slice(0, limit)
}

// ─────────────────────────── 反馈 ───────────────────────────
/** 反馈文件：`<root>/feedback.json` = [{ rel, query, useful }]。用于「用过的记一笔」。 */
export function readFeedback(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'feedback.json'), 'utf8')) } catch { return [] }
}
export function addFeedback(root, { rel, query, useful }) {
  const file = path.join(root, 'feedback.json')
  const list = readFeedback(root)
  list.push({ rel, query, useful: Boolean(useful), at: new Date().toISOString() })
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { encoding: 'utf8' })
  invalidate(root)
  return list.length
}

// ─────────────────────────── 只读便捷 ───────────────────────────
/** 库统计（不含正文，便宜）。 */
export function stats(root) {
  const idx = buildIndex(root)
  const groups = new Map()
  const tags = new Map()
  let bytes = 0
  let newest = 0
  for (const e of idx.entries) {
    bytes += e.size
    if (e.mtime > newest) newest = e.mtime
    if (e.group) groups.set(e.group, (groups.get(e.group) || 0) + 1)
    for (const t of e.tagsCanon) tags.set(t, (tags.get(t) || 0) + 1)
  }
  return {
    root,
    entries: idx.entries.length,
    bytes,
    newest: newest ? new Date(newest).toISOString() : null,
    groups: [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => ({ group: g, entries: n })),
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) => ({ tag: t, df: n })),
    syncedAt: new Date(idx.builtAt).toISOString(),
  }
}

/** 列条目（按 mtime 降序）。 */
export function list(root, { limit = 30, offset = 0, group = '' } = {}) {
  const idx = buildIndex(root)
  return idx.entries
    .filter((e) => !group || String(e.group) === String(group))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(offset, offset + limit)
    .map((e) => ({ id: e.id, rel: e.rel, title: e.title, tags: e.tags, group: e.group, date: e.date, size: e.size, mtime: e.mtime }))
}

/** 按 id / 相对路径 / 标题定位一条。返回完整记录或 null。 */
export function read(root, key) {
  const idx = buildIndex(root)
  const k = String(key || '').trim()
  if (!k) return null
  let e = idx.entries.find((x) => x.id === k || x.rel === k || x.rel === k + '.md')
  if (!e) e = idx.entries.find((x) => x.rel.toLowerCase().endsWith('/' + k.toLowerCase()) || x.title === k)
  if (!e) e = idx.entries.find((x) => x.id.startsWith(k) || x.rel.toLowerCase().includes(k.toLowerCase()))
  if (!e) return null
  // 只回传有意义的字段：把索引用的预计算缓存（headLc/hayLc/tagsCanon）剔掉，别让调用方看到内部结构
  const { headLc, hayLc, tagsCanon, ...clean } = e
  return { ...clean, hash: shortHash(e.rel) }
}

/** 只看同义词组映射（排障用）。 */
export function synonymDump(root) {
  return [...synonymMap(root).entries()].map(([w, g]) => ({ word: w, group: g }))
}
