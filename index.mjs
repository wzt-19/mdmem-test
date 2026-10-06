/**
 * index.mjs —— 门面（给脚本 / 应用用的统一入口）
 *
 *   import { openMemoryLibrary } from './index.mjs'
 *   const mem = openMemoryLibrary({ root: './notes' })
 *   await mem.write({ title, body, tags, group })
 *   mem.search('老王喜欢聊什么')
 *   mem.read('2026-10-05-a1b2c3')
 *   await mem.distillIfNeeded({ messages, callLLM })
 *
 * 设计：**同步优先**（文件 IO + 全扫都是毫秒级），只有蒸馏是 async。
 */

import path from 'node:path'
import fs from 'node:fs'
import { readEntry, writeEntry, trashEntry, restoreEntry, listTrash, scanFiles } from './store.mjs'
import { addFeedback, invalidate, list, read, search, stats } from './retrieve.mjs'
import { DEFAULT_DISTILL_BUDGET, distillIfNeeded, distillToLibrary, renderMessages, shouldDistill } from './distill.mjs'

export { DEFAULT_DISTILL_BUDGET, shouldDistill, renderMessages }
export * as terms from './terms.mjs'
export * as store from './store.mjs'

/** 打开（必要时创建）一个 md 记忆库。 */
export function openMemoryLibrary({ root, group = '', ensure = true } = {}) {
  if (!root) throw new Error('openMemoryLibrary 需要 root（记忆库目录）')
  const abs = path.resolve(root)
  if (ensure) fs.mkdirSync(abs, { recursive: true })

  return {
    root: abs,
    group,

    /** 检索。返回按 score 降序的命中数组。 */
    search(query, opts = {}) {
      return search(abs, query, { group, ...opts })
    },

    /** 读单条。key 可以是 id / 相对路径 / 标题（支持前缀与模糊）。 */
    read(key) {
      return read(abs, key)
    },

    /** 写一条。 */
    write({ title, body, tags = [], group: g = group, source = '', importance = 0.5, when, rel = null } = {}) {
      if (!title || !String(title).trim()) throw new Error('write 需要 title')
      if (!body || !String(body).trim()) throw new Error('write 需要 body')
      const r = writeEntry(abs, { title: String(title).trim(), body: String(body).trim(), tags, group: g, source, importance, when, rel })
      invalidate(abs)
      return r
    },

    /** 列条目（按时间倒序）。 */
    list(opts = {}) {
      return list(abs, { group, ...opts })
    },

    /** 库统计。 */
    stats() {
      return stats(abs)
    },

    /** 软删（进 <root>/.trash/，可恢复）。 */
    remove(key) {
      const e = read(abs, key)
      if (!e) throw new Error(`找不到：${key}`)
      const moved = trashEntry(abs, e.rel)
      invalidate(abs)
      return { moved, rel: e.rel, title: e.title }
    },

    /** 从回收站恢复（传 rel）。 */
    restore(rel) {
      const p = restoreEntry(abs, rel)
      invalidate(abs)
      return p
    },

    /** 回收站清单。 */
    trash() {
      return listTrash(abs)
    },

    /** 记一笔「这条有用/没用」，下次同查询会加权。 */
    feedback({ rel, query, useful }) {
      return addFeedback(abs, { rel, query, useful })
    },

    /** 待蒸馏文本长度 / 是否该蒸。 */
    chars(messages) { return renderMessages(messages).length },
    shouldDistill(messages, budget = DEFAULT_DISTILL_BUDGET) { return shouldDistill(renderMessages(messages).length, budget) },

    /** 蒸馏并落库（LLM 可注入）。 */
    distill({ messages, callLLM, ...rest } = {}) {
      return distillToLibrary({ root: abs, group, messages, callLLM, ...rest })
    },

    /** 够长才蒸馏。 */
    distillIfNeeded({ messages, callLLM, budget = DEFAULT_DISTILL_BUDGET, ...rest } = {}) {
      return distillIfNeeded({ root: abs, group, messages, callLLM, budget, ...rest })
    },

    /** 手工改了 md 后强制重建索引（一般不需要）。 */
    invalidate() { invalidate(abs) },

    /** 全量重读一条（绕过索引）。 */
    readFresh(key) {
      for (const f of scanFiles(abs)) {
        try {
          const e = readEntry(abs, f.rel)
          if (e.id === key || e.rel === key || e.title === key) return e
        } catch { /* skip */ }
      }
      return null
    },
  }
}
