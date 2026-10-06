// verify-cli.mjs —— CLI 端到端验证：用 spawn + 参数数组调用（避开 shell 引号被吃的老坑）
//
// 依赖 verify.mjs 跑出来的 _selftest 语料（那边先跑一遍再跑这个）。
// 断言里的标题/查询词是与那份语料**成对**的，改语料时必须同步改这里。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'cli.mjs')
const ROOT = path.join(HERE, '_selftest')

let pass = 0, fail = 0
const ok = (c, msg, extra = '') => { if (c) { pass++; console.log(`  ✅ ${msg}`) } else { fail++; console.log(`  ❌ ${msg}${extra ? ' — ' + extra : ''}`) } }

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, '--root', ROOT, ...args], { encoding: 'utf8', timeout: 60000 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

console.log('\n【CLI】检索')
{
  const r = cli(['search', '老王'])
  ok(r.code === 0 && r.out.includes('老王'), 'search 有输出且含目标', r.out.split('\n')[1]?.slice(0, 60))
  const j = cli(['search', '什么叫抽象话', '--json'])
  let arr = []
  try { arr = JSON.parse(j.out) } catch { /* ignore */ }
  ok(Array.isArray(arr) && arr.length > 0, `--json 返回可解析数组（${arr.length} 条）`)
  ok(arr[0] && typeof arr[0].score === 'number' && typeof arr[0].coverage === 'number', 'JSON 里带 score / coverage')
}

console.log('\n【CLI】阴性对照（生成式，代码里不写死对照串）')
{
  // 稀疏 CJK 取样（**不能用私用区**：那会被 queryTerms 丢掉，查询变空 ⇒ 测了个假阴性）
  let x = 20261006
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
  const BLOCKS = [0x4E00, 0x5200, 0x5600, 0x5E00, 0x6700, 0x7300, 0x7C00, 0x8800, 0x9200, 0x9A00]
  const chr = () => String.fromCharCode(BLOCKS[Math.floor(rnd() * BLOCKS.length)] + Math.floor(rnd() * 0x60))
  const q = chr() + chr() + chr() + String(Math.floor(rnd() * 9000) + 1000)
  const r = cli(['search', q])
  ok(r.code === 0 && /无命中/.test(r.out), '不存在的查询 → 明确返回「无命中」而不是凑数', r.out.slice(0, 60))
  // 量具自检：确认**中文**查询经命令行传参没被破坏。
  // 为什么不用 Unicode 私用区当探针：Node 在 Windows 上传非标准字符的 argv 本身就会丢字符
  // （实测私用区字符到不了子进程），那是运行时的边界，不是这个库的问题 —— 拿它当断言会误导。
  // 这里验证真实场景：查询中文、命中一条、结果里带着那条记录的标题。
  const mixed = cli(['search', '配置项的容量上限是多少'])
  ok(/命中/.test(mixed.out) && mixed.out.includes('配置项容量上限'), '中文查询经命令行传参可正常命中（量具自检）', mixed.out.split('\n')[0])
}

console.log('\n【CLI】读单条')
{
  const r = cli(['read', '配置项容量上限'])
  ok(r.code === 0 && r.out.includes('最多保留'), '按标题读单条成功', r.out.split('\n')[0])
  const bad = cli(['read', '根本不存在的条目xyz'])
  ok(bad.code !== 0 && bad.err.includes('找不到'), '读不到时报错且退出码非 0')
}

console.log('\n【CLI】写一条 + 读回验证')
{
  const r = cli(['write', '--title', 'CLI 写入测试条目', '--body', '这是命令行写入的正文，用于验证写后读回。', '--tags', '测试,CLI', '--group', 'proj-alpha'])
  ok(r.code === 0 && r.out.includes('已写入并读回验证'), 'write 成功且做了读回验证', r.out.split('\n')[1])
  const m = r.out.match(/id\s*:\s*(\S+)/)
  const id = m?.[1]
  ok(Boolean(id), `拿到 id=${id}`)
  const back = cli(['read', id])
  ok(back.code === 0 && back.out.includes('命令行写入的正文'), '用该 id 能读回同一条')
  // 清理：软删它（软删可恢复，符合"删前留退路"的纪律）
  const rm = cli(['rm', id])
  ok(rm.code === 0 && rm.out.includes('已软删'), 'rm 默认软删', rm.out.split('\n')[1])
}

console.log('\n【CLI】列表 / 统计')
{
  const r = cli(['list', '--limit', '5'])
  ok(r.code === 0 && r.out.includes('条（按时间倒序）'), 'list 正常')
  const s = cli(['stats'])
  let j = null
  try { j = JSON.parse(s.out) } catch { /* ignore */ }
  ok(j && typeof j.entries === 'number', `stats 返回 JSON（entries=${j?.entries}）`)
}

console.log('\n【CLI】回收站与恢复')
{
  const t = cli(['trash'])
  ok(t.code === 0, 'trash 可列', t.out.split('\n')[0])
  const rows = t.out.split('\n').slice(1).filter(Boolean)
  const rel = rows[0]?.split(/\s{2,}/).pop()?.trim()
  if (rel) {
    const rs = cli(['restore', rel])
    ok(rs.code === 0 && rs.out.includes('已恢复'), `restore 成功（${rel}）`)
  } else {
    ok(false, '回收站里没找到可恢复条目')
  }
}

console.log('\n【CLI】永久删除必须有 --yes 才肯做')
{
  const r = cli(['rm', '配置项容量上限', '--permanent'])
  ok(r.code === 2 && r.err.includes('--yes'), '缺 --yes 时拒绝永久删除（安全闸生效）', r.err.slice(0, 80))
}

console.log('\n【CLI】蒸馏 --dry（不接 LLM，只看提示词）')
{
  const f = path.join(HERE, '_selftest-chat.json')
  fs.writeFileSync(f, JSON.stringify([
    { speaker: '老王', text: '别老 @ 我' },
    { speaker: '小张', text: '哈哈哈' },
  ], null, 2), 'utf8')
  const r = cli(['distill', '--messages', f, '--dry', '--budget', '10'])
  ok(r.code === 0 && r.out.includes('SYSTEM') && r.out.includes('USER'), '--dry 打印提示词', r.out.split('\n')[0])
  ok(r.out.includes('长期记忆整理器'), '提示词内容正确')
  fs.rmSync(f, { force: true })
}

console.log('\n【CLI】缺 --root 必须拒绝（不猜默认目录）')
{
  const r = spawnSync(process.execPath, [CLI, 'stats'], { encoding: 'utf8' })
  ok(r.status === 2 && (r.stderr || '').includes('必须指定记忆库目录'), '无 root 时报错退出', (r.stderr || '').trim().slice(0, 60))
}

console.log('\n' + '='.repeat(64))
console.log(`CLI 验证：${pass}/${pass + fail} 通过${fail ? `，${fail} 项 ❌` : ' —— 全过 ✅'}`)
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
