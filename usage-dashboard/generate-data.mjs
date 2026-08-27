#!/usr/bin/env node
/**
 * DSH 用量统计 · 数据生成器
 *
 * 扫描 $DSH_HOME/sessions 下所有会话日志（多帧 zstd 压缩的 JSONL），
 * 汇总为 工作区 → 会话 → 每次回答（turn） 三层结构，输出：
 *   - dsh-data.json   （供服务器模式轮询）
 *   - dsh-data.js     （window.__DSH_DATA__，供 file:// 直接打开）
 *
 * 用法: node generate-data.mjs [--home <DSH_HOME>] [--out <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const APPEND = 120 // 回答预览字数
const PROMPT = 90  // 提问预览字数

/* ---------------- zstd 多帧结构扫描（同 session-persistence-jsonl/src/zstd.ts） ---------------- */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解压一个会话日志为记录数组；跳过损坏/未完成的尾部帧。 */
function readSessionRecords(artifactPath) {
  const raw = fs.readFileSync(artifactPath)
  const { frames } = scanZstdFrames(raw)
  const records = []
  for (const f of frames) {
    let text
    try {
      text = zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { records.push(JSON.parse(t)) } catch { /* 跳过坏行 */ }
    }
  }
  return records
}

/* ---------------- 辅助 ---------------- */
function previewText(content, max) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    if (text.length >= max) break
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

function decodeWorkspaceDir(dirName) {
  // 目录名形如 --D-dshProject-plugIn--（':' 与 '\' 被编码为 '-'）
  let inner = dirName
  if (inner.startsWith('--') && inner.endsWith('--')) inner = inner.slice(2, -2)
  const parts = inner.split('-')
  const drive = parts[0]
  const rest = parts.slice(1).join('\\')
  return rest ? `${drive}:\\${rest}` : drive
}

/* ---------------- 主流程 ---------------- */
function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

const dshHome = argValue('--home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const outDir = argValue('--out') || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const sessionsRoot = path.join(dshHome, 'sessions')

if (!fs.existsSync(sessionsRoot)) {
  console.error(`未找到会话目录: ${sessionsRoot}`)
  process.exit(1)
}

const workspaces = []
let skippedFiles = 0
const droppedTurns = []

for (const wsName of fs.readdirSync(sessionsRoot).sort()) {
  const wsPath = path.join(sessionsRoot, wsName)
  let stat
  try { stat = fs.statSync(wsPath) } catch { continue }
  if (!stat.isDirectory()) continue

  const sessionDirs = fs.readdirSync(wsPath).filter((d) => {
    try { return fs.statSync(path.join(wsPath, d)).isDirectory() } catch { return false }
  })

  for (const sid of sessionDirs) {
    const dir = path.join(wsPath, sid)
    let artifact = null
    for (const cand of ['session.jsonl.zstd', 'session.jsonl']) {
      if (fs.existsSync(path.join(dir, cand))) { artifact = path.join(dir, cand); break }
    }
    if (!artifact) continue

    let records
    try { records = readSessionRecords(artifact) } catch { skippedFiles += 1; continue }

    const meta = records.find((r) => r.type === 'session') || {}
    if (!meta.id) continue

    const cwd = typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : decodeWorkspaceDir(wsName)
    const titleRec = [...records].reverse().find((r) => r.type === 'session/title' && r.data && typeof r.data.title === 'string' && r.data.title)
    const lastModelByStep = {}

    /* turn/step 索引 */
    const turnStart = new Map()   // turn -> time
    const turnEnd = new Map()     // turn -> { time, reason }
    const stepStart = new Map()   // "t:s" -> time
    const stepEnd = new Map()     // "t:s" -> time
    const stepMessages = new Map()// "t:s" -> [{ time, model, provider, usage, msg }]
    const turnUser = new Map()    // turn -> 第一条人工提问
    const turnStatus = new Map()  // turn -> 状态标记
    const lastAnyTime = { t: 0 }

    for (const r of records) {
      const time = r.time
      if (typeof time === 'number' && time > lastAnyTime.t) lastAnyTime.t = time
      switch (r.type) {
        case 'turn/start':
          if (typeof r.data?.turn === 'number') {
            turnStart.set(r.data.turn, time)
            if (turnStatus.get(r.data.turn) === undefined) turnStatus.set(r.data.turn, 'running')
          }
          break
        case 'turn/end': {
          const turn = r.data?.turn
          if (typeof turn === 'number') {
            turnEnd.set(turn, { time, reason: r.data?.reason || null })
            turnStatus.set(turn, 'done')
          }
          break
        }
        case 'step/start': {
          const key = `${r.data?.turn}:${r.data?.step}`
          if (typeof r.data?.turn === 'number' && typeof r.data?.step === 'number') stepStart.set(key, time)
          break
        }
        case 'step/end': {
          const key = `${r.data?.turn}:${r.data?.step}`
          if (typeof r.data?.turn === 'number' && typeof r.data?.step === 'number') stepEnd.set(key, time)
          break
        }
        case 'user/message': {
          const turn = r.data?.turn
          if (typeof turn === 'number' && !turnUser.has(turn)) {
            const kind = r.data?.source?.kind
            const isSnapshot = r.data?.source?.form === 'snapshot'
            // 人工提问优先；子代理提示词（agent）其次；跳过运行时快照噪音
            if (kind === 'user' || (kind === 'agent' && !isSnapshot) || (!kind && !isSnapshot)) {
              turnUser.set(turn, previewText(r.data?.content, PROMPT))
            }
          }
          break
        }
        case 'assistant/message': {
          const turn = r.data?.turn
          const step = r.data?.step
          if (typeof turn !== 'number' || typeof step !== 'number') break
          const source = r.data?.message?.source || {}
          const model = source.model || lastModelByStep[`${turn}:${step}`] || 'unknown'
          lastModelByStep[`${turn}:${step}`] = model
          const key = `${turn}:${step}`
          if (!stepMessages.has(key)) stepMessages.set(key, [])
          stepMessages.get(key).push({ time, model, provider: source.provider || '', usage: r.data?.usage || null, msg: r.data?.message || null })
          break
        }
        default:
          break
      }
    }

    /* 组装 turn 明细 */
    const turns = []
    const turnNumbers = [...new Set([...turnStart.keys(), ...turnEnd.keys(), ...stepMessages.keys()].map((k) => {
      const m = String(k).match(/^(\d+):/)
      return m ? Number(m[1]) : null
    }).filter((n) => n !== null))].sort((a, b) => a - b)

    for (const turn of turnNumbers) {
      let models = {}
      let calls = 0
      let startTime = turnStart.get(turn) ?? null
      let endTime = turnEnd.get(turn)?.time ?? null
      let minTime = Infinity
      let maxTime = -Infinity
      const steps = []

      const stepKeys = [...stepMessages.keys()].filter((k) => String(k).startsWith(`${turn}:`)).sort((a, b) => {
        const na = Number(a.split(':')[1]), nb = Number(b.split(':')[1])
        return na - nb
      })

      for (const key of stepKeys) {
        const entries = stepMessages.get(key)
        const last = entries[entries.length - 1]
        const usage = last?.usage || {}
        const u = {
          input: usage.inputTokens || 0,
          cache: (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0),
          output: usage.outputTokens || 0,
          reasoning: usage.reasoningTokens || 0,
        }
        const m = last?.model || 'unknown'
        const prev = models[m] || { calls: 0, input: 0, cache: 0, output: 0, reasoning: 0, provider: last?.provider || '' }
        prev.calls += 1
        prev.input += u.input
        prev.cache += u.cache
        prev.output += u.output
        prev.reasoning += u.reasoning
        models[m] = prev
        calls += 1

        const st = stepStart.get(key)
        const so = stepEnd.get(key) ?? last?.time ?? st
        if (st != null && st < minTime) minTime = st
        if (so > maxTime) maxTime = so
        if (startTime == null && st != null) startTime = st
        if (endTime == null && so != null) endTime = so

        steps.push({
          s: Number(key.split(':')[1]),
          m, p: last?.provider || '',
          t: st ?? last?.time ?? null,
          d: so != null && st != null ? Math.max(0, so - st) : null,
          ...u,
        })
      }

      if (calls === 0 && turnStart.has(turn) === false) continue // 空序列跳过
      if (turnStart.has(turn) === false && calls === 0) continue

      const status = turnStatus.get(turn) === 'done' ? 'done' : 'running'
      // 回答预览：该 turn 内最后一条带文本的 assistant/message
      let answer = ''
      for (const key of stepKeys) {
        for (const e of stepMessages.get(key) || []) {
          const text = previewText(e.msg?.content, APPEND)
          if (text) answer = text
        }
      }
      const reason = turnEnd.get(turn)?.reason
      turns.push({
        t: turn,
        s: startTime,
        e: endTime ?? (Number.isFinite(maxTime) ? maxTime : null),
        d: startTime != null && endTime != null ? Math.max(0, endTime - startTime) : (Number.isFinite(minTime) ? maxTime - minTime : null),
        status,
        reason: reason ? (reason.kind || 'unknown') : null,
        user: turnUser.get(turn) || '',
        answer,
        models,
        steps,
        calls,
      })
    }

    /* 会话聚合 */
    const totals = { calls: 0, input: 0, cache: 0, output: 0, reasoning: 0, turns: turns.length }
    const models = {}
    for (const turn of turns) {
      for (const [m, v] of Object.entries(turn.models)) {
        totals.calls += v.calls
        totals.input += v.input
        totals.cache += v.cache
        totals.output += v.output
        totals.reasoning += v.reasoning
        const p = models[m] || { calls: 0, input: 0, cache: 0, output: 0, reasoning: 0 }
        p.calls += v.calls; p.input += v.input; p.cache += v.cache; p.output += v.output; p.reasoning += v.reasoning
        models[m] = p
      }
    }

    workspaces.push({
      wsDir: wsName,
      cwd,
      session: {
        id: meta.id,
        title: titleRec?.data?.title || null,
        createdAt: meta.createdAt ?? null,
        depth: meta.delegationDepth ?? 0,
        preset: meta.agentPreset || null,
        firstAt: turns.length ? Math.min(...turns.map((t) => t.s ?? t.e ?? Infinity)) : lastAnyTime.t,
        lastAt: turns.length ? Math.max(...turns.map((t) => t.e ?? t.s ?? 0)) : lastAnyTime.t,
        models, totals,
        turns,
      },
    })
  }
}

/* 按工作区分组 */
const byCwd = new Map()
for (const w of workspaces) {
  const key = w.cwd
  if (!byCwd.has(key)) byCwd.set(key, { name: w.cwd, display: path.basename(w.cwd) || w.cwd, sessions: [] })
  byCwd.get(key).sessions.push(w.session)
}

const result = {
  generatedAt: Date.now(),
  dshHome,
  currency: 'CNY',
  workspaces: [...byCwd.values()],
}

fs.mkdirSync(outDir, { recursive: true })
const jsonPath = path.join(outDir, 'dsh-data.json')
const jsPath = path.join(outDir, 'dsh-data.js')
fs.writeFileSync(jsonPath, JSON.stringify(result))
fs.writeFileSync(jsPath, `window.__DSH_DATA__ = ${JSON.stringify(result)}\n`)

/* 汇总输出 */
const allModels = new Map()
let allTurns = 0, allCalls = 0, allInput = 0, allCache = 0, allOutput = 0, allReasoning = 0
for (const ws of result.workspaces) {
  for (const s of ws.sessions) {
    allTurns += s.totals.turns
    allCalls += s.totals.calls
    allInput += s.totals.input
    allCache += s.totals.cache
    allOutput += s.totals.output
    allReasoning += s.totals.reasoning
    for (const [m, v] of Object.entries(s.models)) {
      const g = allModels.get(m) || { calls: 0, input: 0, cache: 0, output: 0, reasoning: 0 }
      g.calls += v.calls; g.input += v.input; g.cache += v.cache; g.output += v.output; g.reasoning += v.reasoning
      allModels.set(m, g)
    }
  }
}
console.log(`DSH_HOME     : ${dshHome}`)
console.log(`会话日志     : ${workspaces.length} 个会话（跳过 ${skippedFiles} 个损坏文件）`)
console.log(`工作区       : ${result.workspaces.length}`)
console.log(`对话轮次     : ${allTurns}`)
console.log(`模型调用     : ${allCalls}`)
console.log(`Token 总量   : ${(allInput + allCache + allOutput).toLocaleString()}（输入 ${allInput.toLocaleString()} / 缓存命中 ${allCache.toLocaleString()} / 输出 ${allOutput.toLocaleString()} / 其中推理 ${allReasoning.toLocaleString()}）`)
console.log(`模型分布     : ${[...allModels].map(([m, v]) => `${m} ${(v.input + v.cache + v.output).toLocaleString()}`).join(' | ')}`)
console.log(`已输出       : ${jsonPath}`)
console.log(`已输出       : ${jsPath}`)
