#!/usr/bin/env node
/**
 * model-probe —— 给 DSH 里配置的模型做「可用性 + 客观题」两层探针。
 *
 *   node probe.mjs --ping 3 --quiz 10 --models gpt-6.1-sol,glm-5.2
 *
 * 设计目标：**客观、便宜、可复现**。
 *   - 第一层：极小的 ping（24 token），量成功率与延迟；
 *   - 第二层：单字母多选题（自建题库 questions.json），精确匹配判分，不用 LLM 当裁判；
 *   - 不做总分排名，只回答"这条线路是否正常 / 是否明显退化"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'desktop'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const PING = Number(opt('ping', 3))
const QUIZ = Number(opt('quiz', 10))
const TIMEOUT = Number(opt('timeout', 30000))
const ONLY = opt('models', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const OUT = opt('out', path.join(HERE, 'report.json'))
const CONFIG = opt('config', '')

// ---------- 读取 key ----------
function readCreds() {
  const k = {}
  try {
    const raw = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*(\S+)\s*$/.exec(line)
      if (m) k[m[1]] = m[2]
    }
  } catch (e) {}
  return k
}
const KEYS = readCreds()
const keyOf = (env) => (env && (process.env[env] || KEYS[env])) || ''

// ---------- 从 DSH profile 解析目标 ----------
function parseDshTargets() {
  const file = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf('- id: llm-pi-ai')
  if (start < 0) throw new Error('profile 里没找到 llm-pi-ai')
  const rest = text.slice(start)
  const end = rest.indexOf('\n- id: ') // 下一个顶层条目
  const block = end > 0 ? rest.slice(0, end) : rest

  const targets = []
  let provider = null
  let cur = null
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const p = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(line)
    if (p) {
      provider = { name: p[1], models: [] }
      targets.push(provider)
      cur = null
      continue
    }
    if (!provider) continue
    const kv = /^ {8}([A-Za-z]+):\s*(.+)$/.exec(line)
    if (kv) {
      provider[kv[1]] = kv[2].trim()
      continue
    }
    const mid = /^ {10}- id:\s*(.+)$/.exec(line)
    if (mid) {
      cur = { id: mid[1].trim() }
      provider.models.push(cur)
      continue
    }
    const mk = /^ {12}([A-Za-z]+):\s*(.+)$/.exec(line)
    if (mk && cur) cur[mk[1]] = mk[2].trim()
  }

  const out = []
  for (const p of targets) {
    const base = (p.baseURL || '').replace(/\/+$/, '')
    if (!base) continue
    for (const m of p.models) {
      if (/embedding/i.test(m.id)) continue // 向量模型不参与对话探针
      out.push({
        provider: p.name,
        api: p.api || 'openai-completions',
        baseURL: base,
        key: keyOf(p.apiKeyEnv),
        model: m.id,
      })
    }
  }
  return out
}

function loadConfigTargets() {
  const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  return (j.targets || j).map((t) => ({
    provider: t.provider || 'custom',
    api: t.api || 'openai-completions',
    baseURL: String(t.baseURL).replace(/\/+$/, ''),
    key: t.key || keyOf(t.apiKeyEnv),
    model: t.model,
  }))
}

// ---------- 请求 ----------
function endpoint(t) {
  const b = t.baseURL
  if (t.api === 'anthropic-messages') {
    return /\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages'
  }
  return /\/v\d+$/.test(b) || /\/api\/v\d+$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions'
}

async function ask(t, prompt, maxTokens) {
  const url = endpoint(t)
  const headers =
    t.api === 'anthropic-messages'
      ? { 'x-api-key': t.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { authorization: 'Bearer ' + t.key, 'content-type': 'application/json' }
  const body =
    t.api === 'anthropic-messages'
      ? { model: t.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
      : { model: t.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }

  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const text = await res.text()
    let content = ''
    let usage = null
    try {
      const j = JSON.parse(text)
      if (t.api === 'anthropic-messages') {
        content = (j.content || []).map((c) => c.text || '').join('')
      } else {
        const msg = j.choices?.[0]?.message || {}
        // 推理模型可能把 token 全花在思考上：正文空时退回推理字段再找字母
        content = msg.content || msg.reasoning_content || msg.reasoning || ''
        if (!content && j.choices?.[0]?.text) content = j.choices[0].text
      }
      usage = j.usage || null
    } catch (e) {
      content = ''
    }
    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(performance.now() - t0),
      content,
      usage,
      error: res.ok ? '' : text.replace(/\s+/g, ' ').slice(0, 160),
    }
  } catch (e) {
    return {
      ok: false,
      status: 'ERR',
      ms: Math.round(performance.now() - t0),
      content: '',
      usage: null,
      error: String(e.message || e).slice(0, 120),
    }
  }
}

function tokensOf(u) {
  if (!u) return 0
  return Number(u.total_tokens || (Number(u.input_tokens || u.prompt_tokens || 0) + Number(u.output_tokens || u.completion_tokens || 0))) || 0
}

function pickLetter(text) {
  const s = String(text || '').trim()
  const m = /\b([A-D])\b/.exec(s) || /^([A-D])/.exec(s)
  return m ? m[1] : ''
}

// ---------- 主流程 ----------
const targets = (CONFIG ? loadConfigTargets() : parseDshTargets()).filter((t) => !ONLY.length || ONLY.includes(t.model))
if (argv.includes('--list')) {
  for (const t of targets) console.log(`${t.provider.padEnd(22)} ${t.api.padEnd(20)} ${t.model}  key=${t.key ? 'yes' : 'NO'}`)
  process.exit(0)
}
if (!targets.length) {
  console.error('没有可测目标')
  process.exit(1)
}

const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8')).slice(0, QUIZ)
const rows = []

console.log(`探针：ping ${PING} 轮 + 客观题 ${questions.length} 道 · 目标 ${targets.length} 个\n`)

for (const t of targets) {
  const label = `${t.provider}/${t.model}`
  if (!t.key) {
    rows.push({ label, skipped: '缺少 API key' })
    console.log(`- ${label}: 跳过（缺少 API key）`)
    continue
  }

  // 1) ping
  const pings = []
  for (let i = 0; i < PING; i++) {
    const r = await ask(t, 'Reply with exactly: OK', 24)
    pings.push(r)
    await new Promise((r2) => setTimeout(r2, 200))
  }
  const okPing = pings.filter((p) => p.ok)
  const lat = okPing.map((p) => p.ms).sort((a, b) => a - b)

  // 2) quiz（只跑前 N 题）
  let correct = 0
  let answered = 0
  let tokens = 0
  const wrong = []
  for (const q of questions) {
    // 96：给推理模型留足思考空间，否则正文会被 reasoning tokens 吃光而假阴性
    const r = await ask(t, q.prompt + '\n\n只回答一个字母（A/B/C/D），不要解释。', 96)
    if (!r.ok) {
      wrong.push(q.id + '(请求失败)')
      continue
    }
    answered++
    tokens += tokensOf(r.usage)
    const got = pickLetter(r.content)
    if (got === q.answer) correct++
    else wrong.push(`${q.id}: 期望${q.answer} 得到${got || '空'}`)
  }

  rows.push({
    label,
    pingOk: okPing.length,
    pingTotal: PING,
    p50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    correct,
    answered,
    quiz: questions.length,
    tokens,
    wrong: wrong.slice(0, 4),
    errors: [...new Set(pings.filter((p) => !p.ok).map((p) => `${p.status} ${p.error}`.trim()))].slice(0, 2),
  })
  console.log(
    `- ${label}: ping ${okPing.length}/${PING} · 中位 ${rows.at(-1).p50 ?? '-'}ms · 客观题 ${correct}/${questions.length}` +
      (wrong.length ? ` · 错: ${wrong.slice(0, 3).join('; ')}` : ''),
  )
}

// ---------- 汇总 ----------
console.log('\n' + '目标'.padEnd(38) + 'ping'.padEnd(8) + '中位'.padEnd(9) + '客观题'.padEnd(9) + 'tokens')
for (const r of rows) {
  if (r.skipped) {
    console.log(r.label.padEnd(38) + 'skip')
    continue
  }
  console.log(
    r.label.padEnd(38) +
      `${r.pingOk}/${r.pingTotal}`.padEnd(8) +
      (r.p50 == null ? '-' : r.p50 + 'ms').padEnd(9) +
      `${r.correct}/${r.quiz}`.padEnd(9) +
      r.tokens,
  )
}

try {
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ping: PING, quiz: questions.length, rows }, null, 2), 'utf8')
  console.log('\n报告：' + OUT)
} catch (e) {
  console.log('报告写入失败：' + e.message)
}
