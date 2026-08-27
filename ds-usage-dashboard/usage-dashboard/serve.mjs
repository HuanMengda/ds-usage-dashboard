#!/usr/bin/env node
/**
 * DSH 用量统计 · 本地静态服务器（零依赖）
 *
 * - 首次访问 /dsh-data.json 时自动生成数据（扫描本机 $DSH_HOME/sessions）
 * - 智能过期：仅当会话日志有新内容（mtime 变化）时重新扫描，页面轮询即自动更新
 * - 跨机器可用：数据文件记录的 dshHome 不存在时，自动回退到本机 ~/.dsh
 * - 启动后自动打开浏览器；--no-open 可禁止
 *
 * 用法: node serve.mjs [--port 3488] [--no-open]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SOURCE_MARGIN_MS = 1_500 // 日志文件 mtime 早于数据文件该毫秒数以内，视为刚写完

const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--port')))
const portArg = process.argv[process.argv.indexOf('--port') + 1]
const PORT = Number(portArg) || Number(process.env.DSH_DASH_PORT) || 3488
const noOpen = args.has('--no-open')

function generate(silent) {
  try {
    execFileSync(process.execPath, ['generate-data.mjs', '--out', DIR], {
      cwd: DIR,
      stdio: silent ? 'ignore' : 'inherit',
    })
    return true
  } catch {
    console.error('[serve] 数据生成失败，将使用已有数据文件')
    return false
  }
}

function dataPath() { return path.join(DIR, 'dsh-data.json') }

/** 会话日志目录候选（目录存在才采用）：数据里的 dshHome → 环境变量 DSH_HOME → ~/.dsh。 */
function sessionsRoot() {
  const candidates = []
  const pushIfExists = (home) => {
    try {
      const p = path.join(home, 'sessions')
      if (fs.existsSync(p)) candidates.push(p)
    } catch {}
  }
  try {
    const j = JSON.parse(fs.readFileSync(dataPath(), 'utf8'))
    if (j && typeof j.dshHome === 'string') pushIfExists(j.dshHome)
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'dsh-data.js'), 'utf8').replace(/^window\.__DSH_DATA__\s*=\s*/, '').replace(/;\s*$/, ''))
    if (j && typeof j.dshHome === 'string') pushIfExists(j.dshHome)
  } catch {}
  const env = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  pushIfExists(env)
  return candidates[0] || null
}

/**
 * 智能过期判定：数据文件缺失，或任一会话日志的 mtime 晚于数据文件
 * （说明 DSH 又写入了新内容）时视为过期，需要重新扫描；否则返回 false。
 */
function isStale() {
  let dataMtime
  try { dataMtime = fs.statSync(dataPath()).mtimeMs } catch { return true }

  const root = sessionsRoot()
  if (!root) return false
  let latest = 0
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) {
          try { const m = fs.statSync(p).mtimeMs; if (m > latest) latest = m } catch {}
        }
      }
    }
    walk(root)
  } catch { return false }
  return latest > dataMtime + SOURCE_MARGIN_MS
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let file = url.pathname === '/' ? 'dashboard.html' : decodeURIComponent(url.pathname.slice(1))

  if (file === 'refresh') {
    generate(false)
    res.writeHead(302, { Location: '/dsh-data.json?t=' + Date.now() })
    res.end()
    return
  }

  const target = path.resolve(DIR, file)
  if (!target.startsWith(path.resolve(DIR) + path.sep) && target !== path.resolve(DIR)) {
    res.writeHead(403); res.end('forbidden'); return
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404); res.end('not found'); return
  }

  if (file === 'dsh-data.json' && isStale()) generate(true)

  const ext = path.extname(target).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  res.end(fs.readFileSync(target))
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`
  console.log(`[serve] DSH 用量统计已启动: ${url}`)
  console.log(`[serve] 数据目录: ${DIR}；页面自动轮询，会话日志有新增内容时自动重扫（智能检测，无变化不重扫）`)
  if (!noOpen) {
    spawnedOpen(url)
  }
})

function spawnedOpen(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true })
    child.unref()
  } catch {
    console.log(`[serve] 请手动打开 ${url}`)
  }
}
