// 性能与规模实测（真实数字，不美化）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryLibrary } from './index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '_bench')
fs.rmSync(ROOT, { recursive: true, force: true })
const mem = openMemoryLibrary({ root: ROOT })

const TITLES = ['成员画像', '术语含义', '时段规矩', '排错顺序', '消息纪律', '容量上限', '偏好记录', '称呼约定']
const BODIES = [
  '这位成员说话直、爱吐槽，但新人问问题基本都会答，不喜欢被叫大佬。常在深夜出现。',
  '组里说的抽象话指用谐音、错别字、反串表达情绪的那类梗，多带调侃意味，不带恶意。',
  '该组白天安静、晚上活跃。凌晨两点后基本没人，此时不主动插话，避免刷屏。',
  '先看 logs/app.log 尾部，再看 logs/access.log；两个都正常时怀疑是上游网关掉线。',
  '长消息只在真的需要完整说明时发（结论、复盘）。一条说清，别拆成十几条刷屏。',
  '每位成员最多保留 20 条印象，单条上限 200 字；每轮注入总量兜底 4000 字。',
  '他坚持不用第三方库，理由是怕引入没人维护的依赖，被劝过很多次都没松口。',
  '用户给助手起的昵称是叫兽，助手自称小助，两个称呼不要弄反。',
]

console.log('规模\t写入耗时\t首次查询\t再查(命中缓存)\t内存 RSS')
for (const N of [50, 200, 500, 1000]) {
  fs.rmSync(ROOT, { recursive: true, force: true })
  const m = openMemoryLibrary({ root: ROOT })
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    m.write({
      title: `${TITLES[i % TITLES.length]}-${i}`,
      body: `${BODIES[i % BODIES.length]}（第 ${i} 条，用于规模测试）`,
      tags: [TITLES[i % TITLES.length].slice(0, 2), '规模测试'],
      group: `proj-${i % 3}`,
    })
  }
  const tWrite = Date.now() - t0
  m.invalidate()
  const t1 = Date.now()
  // 用一道**真能命中**的查询，数字才有意义（之前用「群里什么时候不该说话」，库里没这词面 → 0 条）
  const r1 = m.search('抽象话是什么意思', { limit: 10 })
  const tFirst = Date.now() - t1
  const t2 = Date.now()
  for (let k = 0; k < 10; k++) m.search('成员是个什么样的人', { limit: 10 })
  const tHot = (Date.now() - t2) / 10
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
  console.log(`${N}\t${tWrite} ms\t\t${tFirst} ms\t\t${tHot.toFixed(1)} ms\t\t${rss} MB   (首查命中 ${r1.length} 条)`)
}
fs.rmSync(ROOT, { recursive: true, force: true })
console.log('\n（_bench 目录已清理）')
