/**
 * store.mjs —— markdown 记忆库的存储层
 *
 * 形态：**一条记忆 = 一个 .md 文件**（人可读、git 友好、可手工编辑）。
 *   <root>/<YYYY-MM>/<slug>.md
 *
 * 文件格式（frontmatter 用严格可解析的子集，不引 YAML 依赖）：
 *   ---
 *   id: 2026-10-05-k3f9a2
 *   title: 老王不喜欢被频繁 @
 *   tags: ["成员","礼仪"]
 *   group: "proj-alpha"
 *   date: 2026-10-05
 *   source: chat
 *   importance: 0.6
 *   ---
 *
 *   正文（markdown，随便写）
 *
 * 设计取舍：
 *   - **不引任何外部依赖**（只用 node 内置）。
 *   - 删除一律**软删**（移到 <root>/.trash/），可恢复；硬删要显式 permanent。
 *   - 写文件**不带 BOM**（本机铁律：BOM 会让部分解析器静默失败）。
 *   - 文件名保留中文（可读性优先），只清洗 Windows 保留字符。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const FM_KEYS = ['id', 'title', 'tags', 'group', 'date', 'source', 'importance', 'updated']
const RESERVED = /[\\/:*?"<>|\u0000-\u001f]/g

// ─────────────────────────── frontmatter ───────────────────────────
/** 解析 `---\n...\n---\n正文`。容错：没有 frontmatter 就把全文当正文。 */
export function parseEntry(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '')
  if (!s.startsWith('---')) return { meta: {}, body: s }
  const end = s.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: s }
  const head = s.slice(3, end).replace(/^\r?\n/, '')
  const body = s.slice(end + 4).replace(/^\r?\n/, '')
  const meta = {}
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const [, k, rawV] = m
    const v = rawV.trim()
    if (v.startsWith('[') || v.startsWith('"')) {
      try { meta[k] = JSON.parse(v) } catch { meta[k] = v }
    } else if (v === '') {
      meta[k] = ''
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      meta[k] = Number(v)
    } else {
      meta[k] = v
    }
  }
  return { meta, body }
}

/** 序列化。顺序固定，便于 git diff。 */
export function serializeEntry(meta, body) {
  const lines = ['---']
  for (const k of FM_KEYS) {
    if (meta[k] === undefined || meta[k] === null || meta[k] === '') continue
    const v = meta[k]
    if (Array.isArray(v)) lines.push(`${k}: ${JSON.stringify(v)}`)
    else if (typeof v === 'number') lines.push(`${k}: ${v}`)
    else lines.push(`${k}: ${JSON.stringify(String(v))}`)
  }
  // 兜底：非标准键也保留（手工写的 frontmatter 不要丢）
  for (const [k, v] of Object.entries(meta)) {
    if (FM_KEYS.includes(k) || v === undefined || v === null || v === '') continue
    lines.push(`${k}: ${Array.isArray(v) || typeof v === 'number' ? JSON.stringify(v) : JSON.stringify(String(v))}`)
  }
  lines.push('---', '')
  return lines.join('\n') + '\n' + String(body ?? '').trimEnd() + '\n'
}

// ─────────────────────────── 文件名 ───────────────────────────
/** 标题 → 文件名 slug：保留中文与字母数字，其余折成 `-`，最长 40 字符。 */
export function slugify(title) {
  let s = String(title ?? '')
    .replace(RESERVED, ' ')
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim()
  if (s.length > 40) s = s.slice(0, 40).replace(/-$/, '')
  return s || 'entry'
}

export const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6)

/** 生成唯一 id：日期 + 标题哈希。 */
export function makeId(title, when = new Date()) {
  const d = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
  return `${d}-${shortHash(title + '|' + when.toISOString())}`
}

const monthDir = (when) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`

// ─────────────────────────── 扫描 ───────────────────────────
const SKIP_DIRS = new Set(['.trash', '.git', 'node_modules'])

/** 递归收集所有 .md（跳过 .trash / .git / node_modules）。 */
export function scanFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const full = path.join(dir, e.name)
        let st
        try { st = fs.statSync(full) } catch { continue }
        out.push({ full, rel: rel ? `${rel}/${e.name}` : e.name, mtime: st.mtimeMs, size: st.size })
      }
    }
  }
  if (fs.existsSync(root)) walk(root, '')
  return out
}

/** 语料指纹：文件数 + 最新 mtime + 总字节 —— 任一变化就重建索引。 */
export function fingerprint(files) {
  let maxM = 0
  let sum = 0
  for (const f of files) { if (f.mtime > maxM) maxM = f.mtime; sum += f.size }
  return `${files.length}|${maxM}|${sum}`
}

export function readEntry(root, rel) {
  const full = path.join(root, rel)
  const text = fs.readFileSync(full, 'utf8')
  const { meta, body } = parseEntry(text)
  const st = fs.statSync(full)
  return {
    id: meta.id || shortHash(rel),
    rel,
    path: full,
    title: meta.title || path.basename(rel, '.md'),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    group: meta.group || '',
    date: meta.date || '',
    source: meta.source || '',
    importance: typeof meta.importance === 'number' ? meta.importance : 0.5,
    meta,
    body,
    mtime: st.mtimeMs,
    size: st.size,
  }
}

/** 写一条（新建或按 rel 覆盖）。返回 { id, rel, path }。 */
export function writeEntry(root, { title, body, tags = [], group = '', source = '', importance = 0.5, when = new Date(), rel = null }) {
  const id = makeId(title, when)
  let targetRel = rel
  if (!targetRel) {
    const dir = monthDir(when)
    const base = slugify(title)
    targetRel = `${dir}/${base}.md`
    if (fs.existsSync(path.join(root, targetRel))) {
      const alt = `${dir}/${base}-${shortHash(id)}.md`
      targetRel = fs.existsSync(path.join(root, alt)) ? `${dir}/${base}-${shortHash(title + Date.now())}.md` : alt
    }
  }
  const full = path.join(root, targetRel)
  // 按 rel 覆盖更新时**复用原 id**：否则每次更新都会生成新 id，引用（清单里的 id）就漂了。
  // 这也是调用方（桥接 / MCP 工具 / 提示词）承诺「传 rel 则 id 不变」的落点。
  let finalId = id
  if (rel && fs.existsSync(full)) {
    try {
      const prev = readEntry(root, targetRel)
      if (prev?.id) finalId = prev.id
    } catch { /* 读不出就退回新 id */ }
  }
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
  const text = serializeEntry(
    { id: finalId, title, tags, group, date, source, importance, updated: new Date().toISOString().slice(0, 19) },
    body,
  )
  fs.writeFileSync(full, text, { encoding: 'utf8' }) // 无 BOM
  return { id: finalId, rel: targetRel, path: full }
}

/** 软删：移到 <root>/.trash/<rel>。返回移动后的路径。 */
export function trashEntry(root, rel) {
  const full = path.join(root, rel)
  if (!fs.existsSync(full)) throw new Error(`不存在：${rel}`)
  const dst = path.join(root, '.trash', rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  let final = dst
  if (fs.existsSync(final)) final = dst.replace(/\.md$/, `-${shortHash(Date.now())}.md`)
  fs.renameSync(full, final)
  return final
}

/** 从回收站恢复。 */
export function restoreEntry(root, rel) {
  const src = path.join(root, '.trash', rel)
  if (!fs.existsSync(src)) throw new Error(`回收站里没有：${rel}`)
  const dst = path.join(root, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (fs.existsSync(dst)) throw new Error(`目标已存在，拒绝覆盖：${rel}`)
  fs.renameSync(src, dst)
  return dst
}

export function listTrash(root) {
  const dir = path.join(root, '.trash')
  if (!fs.existsSync(dir)) return []
  return scanFiles(dir).map((f) => ({ rel: f.rel, mtime: f.mtime, size: f.size }))
}
