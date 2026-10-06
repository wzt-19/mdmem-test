#!/usr/bin/env node
/**
 * cli.mjs —— 命令行入口
 *
 * 所有命令都从 root 出发；root 取 `--root <dir>`，否则环境变量 MDMEM_ROOT，
 * 否则报错（**不猜默认目录** —— 猜错会写进不该写的地方）。
 *
 *   mdmem-test --root <dir> search "老王喜欢聊啥" [--limit 10] [--group proj] [--json]
 *   mdmem-test --root <dir> read <id|路径|标题>
 *   mdmem-test --root <dir> write --title "..." --body "..." [--tags a,b] [--group G]
 *   mdmem-test --root <dir> list [--limit 20]
 *   mdmem-test --root <dir> stats
 *   mdmem-test --root <dir> rm <key> [--permanent --yes]
 *   mdmem-test --root <dir> trash | restore <rel>
 *   mdmem-test --root <dir> distill --messages <file> [--budget N] [--max N] [--dry] [--group G]
 *   mdmem-test --root <dir> synonyms
 */

import fs from 'node:fs'
import path from 'node:path'
import { openMemoryLibrary } from './index.mjs'
import { makeOpenAICompatLLM, renderMessages } from './distill.mjs'
import { synonymDump } from './retrieve.mjs'
import { trashEntry } from './store.mjs'

// ─────────── 极简参数解析（不引依赖）───────────
function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { opts[key] = true } else { opts[key] = next; i++ }
    } else opts._.push(a)
  }
  return opts
}

const argv = process.argv.slice(2)
const opts = parseArgs(argv)
const cmd = opts._[0]

const root = opts.root || process.env.MDMEM_ROOT
if (!root) {
  console.error('✗ 必须指定记忆库目录：--root <dir>  或  环境变量 MDMEM_ROOT')
  process.exit(2)
}
if (!fs.existsSync(root) && !['write', 'distill'].includes(cmd)) {
  console.error(`✗ 目录不存在：${root}`)
  process.exit(2)
}

const mem = openMemoryLibrary({ root })
const json = (v) => { console.log(JSON.stringify(v, null, 2)) }
const need = (cond, msg) => { if (!cond) { console.error(`✗ ${msg}`); process.exit(2) } }

switch (cmd) {
  case 'search': {
    const q = opts._.slice(1).join(' ')
    need(q, '用法：search "查询词"')
    const hits = mem.search(q, {
      limit: Number(opts.limit || 10),
      tagWeight: opts.tagWeight !== undefined ? Number(opts.tagWeight) : 1,
      headWeight: opts.headWeight !== undefined ? Number(opts.headWeight) : 2,
    })
    if (opts.json) { json(hits); break }
    if (!hits.length) { console.log('（无命中 —— 已按相关性门槛过滤弱命中，不凑数返回）'); break }
    console.log(`命中 ${hits.length} 条：\n`)
    hits.forEach((h, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${h.score.toFixed(2)}] ${h.title}`)
      console.log(`    ${h.rel}   覆盖 ${(h.coverage * 100).toFixed(0)}%  标签 ${h.tags.join('/') || '-'}`)
      if (h.excerpt) console.log(`    ${h.excerpt.slice(0, 110)}${h.excerpt.length > 110 ? '…' : ''}`)
    })
    break
  }

  case 'read': {
    const key = opts._[1]
    need(key, '用法：read <id|路径|标题>')
    const e = mem.read(key)
    need(e, `找不到：${key}`)
    if (opts.json) { json(e); break }
    console.log(`# ${e.title}`)
    console.log(`id=${e.id}  rel=${e.rel}  日期=${e.date || '-'}  group=${e.group || '-'}`)
    console.log(`标签: ${e.tags.join(', ') || '-'}   重要性: ${e.importance}`)
    console.log('─'.repeat(60))
    console.log(e.body)
    break
  }

  case 'write': {
    const title = opts.title
    const body = opts['body-file'] ? fs.readFileSync(opts['body-file'], 'utf8') : opts.body
    need(title, '用法：write --title "..." (--body "..." | --body-file f)')
    need(body, '需要 --body 或 --body-file')
    const tags = opts.tags ? String(opts.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
    const r = mem.write({
      title, body, tags,
      group: opts.group ? String(opts.group) : '',
      source: opts.source ? String(opts.source) : 'cli',
      importance: opts.importance !== undefined ? Number(opts.importance) : 0.5,
    })
    // 读回验证（铁律：不以返回值当成功依据）
    const back = mem.read(r.id)
    if (!back) { console.error('✗ 写入后读回失败！'); process.exit(1) }
    if (opts.json) { json({ ...r, verified: true }); break }
    console.log(`✅ 已写入并读回验证`)
    console.log(`   id  : ${r.id}`)
    console.log(`   路径: ${r.path}`)
    console.log(`   标题: ${back.title}   标签: ${back.tags.join(', ') || '-'}   正文 ${back.body.length} 字`)
    break
  }

  case 'list': {
    const rows = mem.list({ limit: Number(opts.limit || 20), group: opts.group ? String(opts.group) : '' })
    if (opts.json) { json(rows); break }
    console.log(`${rows.length} 条（按时间倒序）：\n`)
    for (const r of rows) console.log(`  ${r.date || '????-??-??'}  ${r.rel}    ${r.title}`)
    break
  }

  case 'stats': json(mem.stats()); break

  case 'rm': {
    const key = opts._[1]
    need(key, '用法：rm <key> [--permanent --yes]')
    const e = mem.read(key)
    need(e, `找不到：${key}`)
    console.log(`将处理：${e.title}`)
    console.log(`  路径: ${path.join(mem.root, e.rel)}`)
    if (!opts.permanent) {
      const r = mem.remove(key)
      const back = mem.read(key)
      console.log(`✅ 已软删（可在回收站恢复）`)
      console.log(`   移到: ${r.moved}`)
      console.log(`   读回确认已不在库中: ${back ? '⚠ 仍能读到！' : '是'}`)
    } else {
      need(opts.yes, '永久删除必须显式加 --yes（软删才是默认）')
      fs.rmSync(path.join(mem.root, e.rel))
      mem.invalidate()
      const back = mem.read(key)
      console.log(`⚠ 已永久删除（不可恢复）: ${e.rel}`)
      console.log(`   读回确认已不在库中: ${back ? '⚠ 仍能读到！' : '是'}`)
    }
    break
  }

  case 'trash': {
    const rows = mem.trash()
    if (opts.json) { json(rows); break }
    console.log(`回收站 ${rows.length} 条：`)
    for (const r of rows) console.log(`  ${new Date(r.mtime).toISOString().slice(0, 19)}  ${r.rel}`)
    break
  }

  case 'restore': {
    const rel = opts._[1]
    need(rel, '用法：restore <rel>')
    const p = mem.restore(rel)
    console.log(`✅ 已恢复 → ${p}`)
    break
  }

  case 'distill': {
    const file = opts.messages
    need(file, '用法：distill --messages <file.json|file.txt> [--budget N] [--max N] [--dry]')
    const raw = fs.readFileSync(file, 'utf8')
    let messages
    try { messages = JSON.parse(raw) } catch { messages = raw }
    const text = renderMessages(messages)
    const budget = Number(opts.budget || 6000)
    console.log(`待蒸馏文本 ${text.length} 字（阈值 ${budget}）→ ${text.length > budget ? '需要蒸馏' : '未超阈值'}`)

    let callLLM = null
    if (!opts.dry) {
      const baseUrl = opts.llmBase || process.env.MDMEM_LLM_BASE
      const apiKey = opts.llmKey || process.env.MDMEM_LLM_KEY
      const model = opts.llmModel || process.env.MDMEM_LLM_MODEL
      need(baseUrl && apiKey && model, '接真 LLM 需要 --llm-base/--llm-key/--llm-model（或 MDMEM_LLM_* 环境变量）；只试提示词请加 --dry')
      callLLM = makeOpenAICompatLLM({ baseUrl, apiKey, model })
    }
    const r = await mem.distill({
      messages, callLLM,
      maxEntries: Number(opts.max || 5),
      group: opts.group ? String(opts.group) : '',
      dryRun: Boolean(opts.dry),
    })
    if (opts.json) { json({ entries: r.entries, written: r.written, raw: r.raw }); break }
    if (opts.dry) {
      console.log('\n===== SYSTEM =====\n' + r.prompt.system)
      console.log('\n===== USER =====\n' + r.prompt.user.slice(0, 1500) + (r.prompt.user.length > 1500 ? '\n…(截断)' : ''))
      break
    }
    console.log(`模型返回 ${r.raw.length} 字 → 解析出 ${r.entries.length} 条`)
    for (const w of r.written) console.log(`  ✅ ${w.rel}   ${w.title}`)
    const back = r.written.length ? mem.read(r.written[0].id) : null
    console.log(`读回验证: ${r.written.length ? (back ? '✅ 首条可读回' : '⚠ 读不到') : '（本次 0 条，未落库）'}`)
    break
  }

  case 'synonyms': {
    const rows = synonymDump(mem.root)
    if (opts.json) { json(rows); break }
    console.log(`同义组 ${rows.length} 个词元（来自内置 + <root>/synonyms.json）：`)
    const seen = new Set()
    for (const r of rows) {
      const k = r.group.join('|')
      if (seen.has(k)) continue
      seen.add(k)
      console.log('  ' + r.group.join(' / '))
    }
    break
  }

  default:
    console.log(`mdmem-test —— markdown 记忆库（检索 / 读 / 写 / 蒸馏）

用法：mdmem-test --root <记忆库目录> <命令> [选项]

  search "<查询词>"        检索（支持换说法：同义组 + 覆盖率闸门 + 标题权重）
  read <id|路径|标题>      读单条
  write --title T (--body B | --body-file F) [--tags a,b] [--group G]
  list [--limit N]         列条目
  stats                    库统计
  rm <key> [--permanent --yes]   软删（默认，可恢复）/ 永久删
  trash / restore <rel>    回收站
  distill --messages <file> [--budget N] [--max N] [--dry]   把对话蒸馏成记忆
  synonyms                 看同义组表

环境变量：MDMEM_ROOT / MDMEM_LLM_BASE / MDMEM_LLM_KEY / MDMEM_LLM_MODEL

不加 --root 会直接报错退出 —— 这个工具不猜默认目录。）`)
}

export { trashEntry }
