/**
 * distill.mjs —— 「上下文过长时把会话蒸馏成记忆」
 *
 * 三件事：
 *   1. 判据：shouldDistill(chars, budget) —— 什么时候该蒸馏
 *   2. 提示词：buildDistillPrompt() —— 让模型输出**严格 JSON 数组**，0 条也合法
 *   3. 落库：distillToLibrary() —— 容错解析 → 写成 md → 返回落库清单
 *
 * LLM 通过 `callLLM({ system, user })` **注入**，本模块不绑定任何厂商：
 *   - 程序里：接你自己的模型客户端
 *   - CLI 里：接 makeOpenAICompatLLM()（任何 OpenAI 兼容端点）
 *   - 测试里：接一个假函数，零成本跑通全链路
 */

import { writeEntry } from './store.mjs'
import { invalidate } from './retrieve.mjs'

/** 默认触发阈值：待蒸馏文本超过这么多字符就该蒸馏（≈ 3~4k token 中文）。 */
export const DEFAULT_DISTILL_BUDGET = 6000

/**
 * 该不该蒸馏。为什么用字符而不是 token：中文 ~1.5 字/token，且不需要引分词器；
 * 阈值本来就是拍的，用字符更省事、更可解释。要精确就传 tokenizer 自己算。
 */
export function shouldDistill(chars, budget = DEFAULT_DISTILL_BUDGET) {
  return Number(chars) > Number(budget)
}

export const DISTILL_SYSTEM = `你是一个长期记忆整理器。你的任务是从一段对话记录里，提炼出**值得长期记住**的内容，写成结构化的记忆条目。

判断标准（严格遵守）：
- 记住：稳定的偏好/习惯、身份与关系、约定与规则、重要事实与结论、反复出现的话题、术语与内部梗的含义、做出的决定。
- 不要记：一次性的闲聊寒暄、单纯的问答过程、没有信息量的表情与应和、临时状态（"在吗""稍等"）、已经在常识里的事。
- 宁缺毋滥：**没有值得记的就返回空数组**。不要为了凑数把闲聊包装成记忆。
- 每条记忆必须能**脱离这段对话独立成立**（不要出现"他刚才说""上面提到"这类指代）。

输出要求（**只输出 JSON，不要任何解释、不要代码围栏**）：
[
  {
    "title": "一句话标题，≤30字，具体、可检索（不要'关于X的讨论'这种空壳）",
    "body": "正文 markdown，2~6 句，写清楚是什么、为什么重要、有什么限定条件",
    "tags": ["3~6个标签", "中文优先", "便于日后按主题召回"],
    "importance": 0.0~1.0 的重要性
  }
]
最多输出 {MAX} 条。没有值得记的就输出 []。`

/** 把对话记录渲染成给模型看的文本。接受多种输入形状。 */
export function renderMessages(messages) {
  if (typeof messages === 'string') return messages.trim()
  if (!Array.isArray(messages)) return ''
  return messages.map((m) => {
    if (typeof m === 'string') return m
    const who = m.speaker ?? m.nickname ?? m.name ?? m.user ?? (m.role === 'assistant' ? 'AI' : '用户')
    const when = m.time ? `[${String(m.time).slice(11, 16)}] ` : ''
    const text = m.text ?? m.content ?? m.message ?? ''
    return `${when}${who}：${String(text).replace(/\s+/g, ' ').trim()}`
  }).filter(Boolean).join('\n')
}

export function buildDistillPrompt(messages, { maxEntries = 5 } = {}) {
  return {
    system: DISTILL_SYSTEM.replace('{MAX}', String(maxEntries)),
    user: `以下是一段对话记录，请提炼值得长期记住的内容：\n\n<<<CHAT\n${renderMessages(messages)}\nCHAT>>>`,
  }
}

/**
 * 容错解析模型输出 → 条目数组。
 * 模型常见毛病：包代码围栏、前后加解释、尾随逗号、单引号。逐个容错（口径参照 vault 的 repairLooseJson）。
 */
export function parseDistilled(text) {
  let s = String(text ?? '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  let arr = null
  try { arr = JSON.parse(s) } catch { /* 继续容错 */ }
  if (!arr) {
    try {
      arr = JSON.parse(s.replace(/,\s*([\]}])/g, '$1').replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3'))
    } catch { /* 放弃 */ }
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const title = String(it.title ?? '').trim()
    const body = String(it.body ?? it.content ?? '').trim()
    if (!title || !body) continue
    const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : []
    const importance = Number.isFinite(Number(it.importance)) ? Math.min(1, Math.max(0, Number(it.importance))) : 0.5
    out.push({ title: title.slice(0, 80), body, tags, importance })
  }
  return out
}

/**
 * 蒸馏并落库。
 * @param {object} p
 * @param {string} p.root        记忆库根目录
 * @param {Array|string} p.messages 聊天记录
 * @param {Function} p.callLLM   async ({system,user}) => string
 * @param {number} [p.maxEntries]
 * @param {string} [p.group]     群号（写进 frontmatter，便于按群过滤）
 * @param {boolean} [p.dryRun]   只生成不落库
 * @returns {Promise<{prompt, raw, entries, written}>}
 */
export async function distillToLibrary({ root, messages, callLLM, maxEntries = 5, group = '', dryRun = false, sessionTitle = '' }) {
  const prompt = buildDistillPrompt(messages, { maxEntries })
  if (typeof callLLM !== 'function') {
    return { prompt, raw: '', entries: [], written: [], skipped: 'no-callLLM' }
  }
  const raw = await callLLM(prompt)
  const entries = parseDistilled(raw)
  if (dryRun || !entries.length) return { prompt, raw, entries, written: [] }

  const source = sessionTitle ? `chat:${sessionTitle}` : 'chat'
  const written = []
  for (const e of entries) {
    const w = writeEntry(root, { ...e, group, source })
    written.push({ ...w, title: e.title })
  }
  invalidate(root)
  return { prompt, raw, entries, written }
}

/**
 * 一站式：够长才蒸馏。
 * 返回 { skipped: 'under-budget', chars, budget } 或蒸馏结果。
 */
export async function distillIfNeeded({ messages, budget = DEFAULT_DISTILL_BUDGET, ...rest }) {
  const text = renderMessages(messages)
  const chars = text.length
  if (!shouldDistill(chars, budget)) return { skipped: 'under-budget', chars, budget }
  const r = await distillToLibrary({ messages, ...rest })
  return { ...r, chars, budget }
}

/**
 * OpenAI 兼容适配器（DeepSeek / 任何兼容端点都用它）。
 * 不引 fetch 之外的东西；无 key 时明确报错而不是静默返回空。
 */
export function makeOpenAICompatLLM({ baseUrl, apiKey, model, temperature = 0.2, timeoutMs = 60000 }) {
  if (!baseUrl) throw new Error('makeOpenAICompatLLM 需要 baseUrl')
  if (!apiKey) throw new Error('makeOpenAICompatLLM 需要 apiKey')
  return async ({ system, user }) => {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j = await r.json()
    return j?.choices?.[0]?.message?.content ?? ''
  }
}
