// dsh-live2d — Host (Node) side.
//
// 职责：
//   1. 监听 DSH 会话事件，跟踪当前 Agent 状态（IDLE / THINKING / WORKING / SUCCESS / ERROR）
//   2. 注册 webserver 路由，供客户端轮询状态、读写配置、加载本地库文件和模型资源
//
// 客户端行为（Live2D 渲染、拖动、设置页）全部在 client.js 中。

import { createRequire } from 'node:module'
import { createReadStream, statSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join, extname, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// DSH 状态常量的单一来源（client 端由 scripts/build-client.mjs 内联同一份定义）
import { DSHState } from './shared/states.js'

const require = createRequire(import.meta.url)

// ── 路径解析 ──────────────────────────────────────────────────────────
// 多种方式尝试解析 __dirname，兼容不同运行环境
let resolvedDir
try {
  resolvedDir = dirname(fileURLToPath(import.meta.url))
} catch {}
if (!resolvedDir) {
  try { resolvedDir = import.meta.dirname } catch {}
}
if (!resolvedDir) {
  try { resolvedDir = dirname(new URL(import.meta.url).pathname) } catch {}
}
if (!resolvedDir) {
  // fallback: 使用 require.resolve 找到 package.json 的位置
  try {
    const pkgPath = require.resolve('../package.json')
    resolvedDir = dirname(pkgPath)
  } catch {}
}

const PLUGIN_ROOT = resolvedDir ? join(resolvedDir, '..') : null
const LIB_DIR = PLUGIN_ROOT ? join(PLUGIN_ROOT, 'lib') : null
const ASSETS_DIR = PLUGIN_ROOT ? join(PLUGIN_ROOT, 'assets') : null

export const name = '@lrplrplrp/dsh-live2d'

const STATE_ENDPOINT = '/plugins/dsh-live2d/state'
// 模型文件夹上传端点（multipart/form-data）。客户端配置以 localStorage 为准，不经此端点。
const UPLOAD_ENDPOINT = '/plugins/dsh-live2d/config'

// ── MIME 类型 ─────────────────────────────────────────────────────────
const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
}

function guessMime(filePath) {
  const ext = extname(filePath).toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

// ── 工具函数 ──────────────────────────────────────────────────────────

// ── 当前状态（内存，客户端轮询读取） ──────────────────────────────────
let currentState = DSHState.IDLE
let stateUpdatedAt = Date.now()

// ── 工具调用跟踪 ──────────────────────────────────────────────────────
const openTools = new Map()
let waitingCallId = undefined
// 本轮是否已开始输出正文（面向用户的对话）。一旦为 true，就保持「输出对话」状态
// 直到本轮 turn 结束：模型常在输出一小段正文后立刻发起工具调用，若让 tool/call
// 抢走状态，SPEAKING 会被反复打断成一闪而过。
let speakingLocked = false
// 本轮的正文统计：是否输出过正文、最后一条正文的字符数。
// 用于在本轮结束时估算「输出对话」应保留多久（非流式链路的可见性补偿）。
let sawDialogueThisTurn = false
let lastDialogueChars = 0
// 本轮实时流里是否出现过正文（由 agent/assistant-stream 维护，与持久化事件互补）
let streamSawDialogue = false
// 延迟切换终结状态（SUCCESS/ERROR）的定时器句柄：新一轮开始时需取消，避免串扰。
let terminalTimer = null

/** 依据正文长度估算「输出对话」状态应保留的时长（毫秒），带上下限。 */
function clampDialogueDwell(chars) {
  const MIN_MS = 1200
  const MAX_MS = 6000
  // 约按 12 字/秒的阅读速度估算，最少 1.2s、最多 6s
  const estimated = Math.round((Number(chars) || 0) / 12 * 1000)
  return Math.max(MIN_MS, Math.min(MAX_MS, estimated))
}

/** 延迟 ms 后进入终结状态，并在其后按 resetMs 回到 IDLE（可被新一轮取消）。 */
function scheduleTerminalState(state, ms, resetMs) {
  if (terminalTimer) { clearTimeout(terminalTimer); terminalTimer = null }
  terminalTimer = setTimeout(() => {
    terminalTimer = null
    setState(state)
    scheduleIdleReset(state, resetMs)
  }, ms)
}

function toolCallIdOf(event, fallback) {
  const data = event?.data || {}
  const msg = data.message || {}
  const content = msg.content
  const contentCallId = Array.isArray(content)
    ? content.find((item) => item?.toolCallId)?.toolCallId
    : undefined
  return String(
    data.message?.source?.callId
    ?? contentCallId
    ?? msg.toolCallId
    ?? msg.callId
    ?? data.callId
    ?? fallback
  )
}

function isUserQuestionTool(name) {
  const value = String(name || '').toLowerCase()
  const tokens = value.split(/[^a-z0-9]+/u).filter(Boolean)
  const asks = new Set(['ask', 'asking', 'request', 'requests', 'prompt', 'needs', 'need', 'get', 'gets'])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set(['question', 'questions', 'input', 'answer', 'answers', 'decision', 'confirmation', 'approval', 'permission'])
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token)) return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode'
  )
  return hasAsk || submitsPlanForApproval
}

function isSubagent(session) {
  return session?.header?.origin === 'subagent'
    || Number(session?.header?.delegationDepth ?? 0) > 0
}

// ── 「输出对话」判定 ───────────────────────────────────────────────────
// DSH 的 assistant/chunk 既承载思维链（reasoning-delta）也承载面向用户的对话
// 正文（text-delta）。只有后者才算“开始输出对话内容”，思维链/工具参数不算。
// 参见 @deepseek-ai/dsh-llm 的 StreamChunk 定义。
function chunkIsDialogue(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
      // 正文增量：需含非空白内容（纯换行/缩进不算开始说话）
      return typeof chunk.text === 'string' && chunk.text.trim().length > 0
    case 'block-end':
      // 完整块：仅 text 块算对话正文；reasoning / tool-call 等不算
      return !!chunk.block && chunk.block.type === 'text'
        && typeof chunk.block.text === 'string' && chunk.block.text.trim().length > 0
    default:
      // reasoning-delta / tool-call-delta / block-start / usage / finish 一律不算
      return false
  }
}

/** 持久化的 assistant/message 是否含面向用户的正文（而非仅思维链/工具调用）。 */
function messageHasDialogue(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block) =>
    block && block.type === 'text'
    && typeof block.text === 'string' && block.text.trim().length > 0)
}

/** 一个 stream chunk 携带的正文长度（非正文返回 0）。 */
function dialogueTextLength(chunk) {
  if (!chunk || typeof chunk !== 'object') return 0
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' ? chunk.text.length : 0
  if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
    return typeof chunk.block.text === 'string' ? chunk.block.text.length : 0
  }
  return 0
}

/** 一条 assistant/message 里所有 text 块的总长度。 */
function messageDialogueLength(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') total += block.text.length
  }
  return total
}

function setState(state) {
  if (currentState !== state) {
    currentState = state
    stateUpdatedAt = Date.now()
    // 实时推送给所有已连接的 SSE 客户端，避免前端轮询延迟
    broadcastState(currentState)
  }
}

// 临时状态（SUCCESS/ERROR）自动回到 IDLE：记录“本次复位对应的设置时刻”，
// 定时器到点时只有仍处于同一次设置（时间戳未变）才复位。避免旧定时器
// 在状态已被后续事件改写后又把 IDLE 覆盖上去。
let pendingIdleResetAt = 0
function scheduleIdleReset(expectedState, delayMs) {
  const setAt = stateUpdatedAt
  pendingIdleResetAt = setAt
  setTimeout(() => {
    if (pendingIdleResetAt === setAt && stateUpdatedAt === setAt && currentState === expectedState) {
      setState(DSHState.IDLE)
    }
  }, delayMs)
}

// ── 状态实时推送（SSE） ──────────────────────────────────────────────
const stateClients = new Set()

/**
 * 处理 `agent/assistant-stream` 的实时帧，用于「正文一开始输出就进入输出对话」。
 * 帧结构见 @deepseek-ai/dsh-agent 的 AssistantStreamFrame：
 *   { type: 'start' } | { type: 'chunk', chunk: StreamChunk } | { type: 'end', outcome }
 * 只有面向用户的 text-delta / text 块才算正文；reasoning-delta（思维链）不算。
 */
function handleAssistantStream(payload) {
  const frame = payload && payload.frame
  if (!frame || typeof frame !== 'object') return

  if (frame.type === 'start') {
    // 一次新的模型流开始：重置本轮的正文统计（新一轮）
    streamSawDialogue = false
    return
  }
  if (frame.type !== 'chunk') return

  const chunk = frame.chunk
  if (!chunkIsDialogue(chunk)) return
  // 正文开始：立即进入「输出对话」并锁定，直到本轮结束
  streamSawDialogue = true
  sawDialogueThisTurn = true
  lastDialogueChars = Math.max(lastDialogueChars, dialogueTextLength(chunk))
  if (!speakingLocked) {
    speakingLocked = true
    setState(DSHState.SPEAKING)
  }
}

function broadcastState(state) {
  const payload = `data: ${JSON.stringify({ state, updatedAt: stateUpdatedAt })}\n\n`
  for (const res of stateClients) {
    try { res.write(payload) } catch {}
  }
}

// ── 会话事件处理 ──────────────────────────────────────────────────────
function handleSessionEvent(session, event) {
  if (!event || typeof event.type !== 'string') return
  if (isSubagent(session)) return

  switch (event.type) {
    case 'turn/start':
      openTools.clear()
      waitingCallId = undefined
      speakingLocked = false
      sawDialogueThisTurn = false
      streamSawDialogue = false
      lastDialogueChars = 0
      // 新一轮开始：取消上一轮可能仍在等待的终结状态切换
      if (terminalTimer) { clearTimeout(terminalTimer); terminalTimer = null }
      setState(DSHState.THINKING)
      break

    case 'assistant/chunk':
      // 仅“面向用户的正文”才算开始输出对话；思维链 / 工具参数增量不改变状态
      // （否则会在思考阶段就误报“输出对话”）。
      if (!chunkIsDialogue(event.data?.chunk)) break
      // 正文一开始就锁住「输出对话」，直到本轮结束（见 speakingLocked 说明）
      speakingLocked = true
      sawDialogueThisTurn = true
      lastDialogueChars = Math.max(lastDialogueChars, dialogueTextLength(event.data?.chunk))
      setState(DSHState.SPEAKING)
      break

    case 'assistant/message':
      // 持久化消息：只有含正文（text 块）才算输出对话；仅思维链/工具调用不算
      if (!messageHasDialogue(event.data)) break
      speakingLocked = true
      sawDialogueThisTurn = true
      lastDialogueChars = Math.max(lastDialogueChars, messageDialogueLength(event.data))
      setState(DSHState.SPEAKING)
      break

    case 'tool/call': {
      const callId = toolCallIdOf(event, `seq-${event.seq ?? 'unknown'}`)
      const name = String(event.data?.name ?? event.data?.message?.name ?? 'tool')
      openTools.set(callId, name)
      // 若该工具是“向用户提问/请求确认”类（AskUserQuestion、exit plan mode 等），
      // 标记为等待用户回答：这类调用会一直挂在 openTools 里（直到用户回复），
      // 用户回复时靠 waitingCallId 把它清掉并回到 THINKING，否则会一直显示 WORKING。
      if (isUserQuestionTool(name)) waitingCallId = callId
      // 已开始输出正文：不被工具调用打断，保持「输出对话」直到本轮结束
      if (speakingLocked) break
      setState(DSHState.WORKING)
      break
    }

    case 'tool/result': {
      const callId = toolCallIdOf(event)
      if (callId) openTools.delete(callId)
      if (callId && callId === waitingCallId) waitingCallId = undefined
      // 已开始输出正文：继续保持「输出对话」
      if (speakingLocked) break
      setState(openTools.size > 0 ? DSHState.WORKING : DSHState.THINKING)
      break
    }

    case 'user/message':
      if (waitingCallId) {
        openTools.delete(waitingCallId)
        waitingCallId = undefined
        // 用户回复后新一轮开始：解除正文锁定，重新从思考开始
        speakingLocked = false
        setState(DSHState.THINKING)
      }
      break

    case 'turn/end': {
      openTools.clear()
      waitingCallId = undefined
      const kind = String(event.data?.reason?.kind ?? 'completed')
      // 本轮是否输出过正文（对话）。是的话，本轮结束时把「输出对话」状态再保留一小会儿
      // 再切到完成/错误 —— 兜底那些正文不流式、assistant/message 一到 turn/end 就紧随的链路。
      const hadDialogue = speakingLocked || sawDialogueThisTurn || streamSawDialogue
      // 本轮结束：解除正文锁定，允许下一轮重新从思考开始
      speakingLocked = false
      sawDialogueThisTurn = false
      streamSawDialogue = false

      if (kind === 'completed') {
        if (hadDialogue) {
          // 按正文长度估算“阅读”时长后，再进入完成状态（有上下限）
          scheduleTerminalState(DSHState.SUCCESS, clampDialogueDwell(lastDialogueChars), 2500)
        } else {
          setState(DSHState.SUCCESS)
          scheduleIdleReset(DSHState.SUCCESS, 2500)
        }
      } else if (kind !== 'blocked') {
        setState(DSHState.ERROR)
        scheduleIdleReset(DSHState.ERROR, 4000)
      }
      break
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 把 URL 子路径解析成 `rootDir` 下的真实文件。
 * 拒绝任何逃出 rootDir 的路径（`..`、绝对路径、分隔符穿越）。
 * @returns 绝对路径，或 null（非法）
 */
function resolveWithin(rootDir, rel) {
  if (!rootDir || !rel) return null
  if (rel.includes('\0')) return null
  // 归一化后为空（如 "."、"./"、"//"）视为非法，避免解析到 rootDir 目录本身
  const abs = resolve(rootDir, rel)
  if (abs === rootDir) return null
  if (abs !== rootDir && !abs.startsWith(rootDir + sep)) return null
  return abs
}

/**
 * 解析 multipart/form-data 请求体（用于上传整个模型文件夹）。
 * 支持字段（field）与文件（file，含 filename 与相对路径 webkitRelativePath）。
 */
async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || ''
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) throw new Error('missing multipart boundary')
  const boundary = m[1] || m[2]
  const delimiter = Buffer.from('\r\n--' + boundary)
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 64 * 1024 * 1024) throw new Error('upload too large (max 64MB)')
    chunks.push(chunk)
  }
  const buf = Buffer.concat(chunks)
  const parts = []
  let start = buf.indexOf(delimiter)
  if (start === -1) return parts
  start += delimiter.length
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break // 结束边界 "--"
    const end = buf.indexOf(delimiter, start)
    if (end === -1) break
    const partBuf = buf.subarray(start, end)
    // partBuf 开头是 \r\n，结尾也是 \r\n
    let headerEnd = partBuf.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const headerStr = partBuf.subarray(2, headerEnd).toString('utf8')
    let content = partBuf.subarray(headerEnd + 4)
    if (content.endsWith('\r\n')) content = content.subarray(0, content.length - 2)
    const headers = {}
    for (const line of headerStr.split('\r\n')) {
      const idx = line.indexOf(':')
      if (idx !== -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
    }
    const disp = headers['content-disposition'] || ''
    const nameM = disp.match(/name="([^"]+)"/i)
    const fileM = disp.match(/filename="([^"]*)"/i)
    const relM = disp.match(/filename\*?=[^;]*webkitrelativepath="([^"]*)"/i)
      || disp.match(/webkitrelativepath="([^"]*)"/i)
    const entry = {
      name: nameM ? nameM[1] : null,
      filename: fileM ? fileM[1] : null,
      webkitRelativePath: relM ? relM[1] : (fileM ? fileM[1] : ''),
      data: content,
    }
    parts.push(entry)
    start = end + delimiter.length
  }
  return parts
}

/** 安全地提供本地文件 */
function serveFile(res, filePath) {
  try {
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const mime = guessMime(filePath)
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'public, max-age=3600',
      'content-length': stat.size,
    })
    createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

// ── 插件入口 ──────────────────────────────────────────────────────────
export function apply(ctx) {
  const logger = ctx.logger ?? console

  if (!PLUGIN_ROOT || !LIB_DIR || !ASSETS_DIR) {
    logger.error?.('[dsh-live2d] Could not resolve plugin root directory. File serving disabled.')
  }

  // 监听会话事件，跟踪 DSH 状态
  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(session, event)
    } catch (err) {
      logger.error?.('dsh-live2d: failed to handle session event', err)
    }
  }, { global: true })

  // 监听「实时助手流」（agent/assistant-stream）：
  // session/event 是「持久化事件日志」，只在事件落盘时触发，因此正文不是流式落盘时
  // 我们只能在 assistant/message（已完成的整条消息）才得知正文存在 —— 触发时机自然滞后。
  // agent/assistant-stream 是逐 chunk 的实时发布（含 text-delta / reasoning-delta），
  // 用它才能做到「正文一开始输出就进入输出对话」。
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    try {
      handleAssistantStream(payload)
    } catch (err) {
      logger.error?.('dsh-live2d: failed to handle assistant stream', err)
    }
  }, { global: true })

  // 注册 webserver 路由
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      // GET /plugins/dsh-live2d/state — 返回当前 Agent 状态
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: STATE_ENDPOINT,
          handler: (req, res) => {
            if (!isLoopback(req.socket?.remoteAddress)) {
              jsonResponse(res, 403, { error: 'local access only' })
              return
            }
            jsonResponse(res, 200, { state: currentState, updatedAt: stateUpdatedAt })
          },
        }),
        'dsh-live2d: state endpoint',
      )

      // GET /plugins/dsh-live2d/state/stream — SSE 实时推送状态变更（替代轮询，消除动画延迟）
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: STATE_ENDPOINT + '/stream',
          handler: (req, res) => {
            if (!isLoopback(req.socket?.remoteAddress)) {
              res.writeHead(403)
              res.end('local access only')
              return
            }
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            // 立即发送当前状态，避免新连接错过最新值
            res.write(`data: ${JSON.stringify({ state: currentState, updatedAt: stateUpdatedAt })}\n\n`)
            stateClients.add(res)
            // 保活：每 15s 发一个注释，防止代理/浏览器断开空闲连接
            const keepAlive = setInterval(() => {
              try { res.write(': keep-alive\n\n') } catch {}
            }, 15000)
            const cleanup = () => {
              clearInterval(keepAlive)
              stateClients.delete(res)
            }
            req.on('close', cleanup)
            req.on('error', cleanup)
          },
        }),
        'dsh-live2d: state sse endpoint',
      )

      // POST /plugins/dsh-live2d/config — 上传整个模型文件夹（multipart/form-data）。
      // 注：原先的 GET/PATCH 分支只是空壳（GET 恒返回 {ok:true}，PATCH 仅回显且从不落盘），
      // 客户端也从不请求它们，已删除以免误导；客户端配置以 localStorage 为准。
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: UPLOAD_ENDPOINT,
          handler: async (req, res) => {
            if (!isLoopback(req.socket?.remoteAddress)) {
              jsonResponse(res, 403, { error: 'local access only' })
              return
            }
            if (req.method !== 'POST') {
              jsonResponse(res, 405, { error: 'method not allowed' })
              return
            }
            // 上传整个模型文件夹：multipart/form-data，字段 dirName + 若干 file（含 webkitRelativePath）
            try {
              if (!ASSETS_DIR) {
                jsonResponse(res, 500, { error: 'assets dir unavailable' })
                return
              }
              const ct = req.headers['content-type'] || ''
              if (!ct.includes('multipart/form-data')) {
                jsonResponse(res, 400, { error: 'expected multipart/form-data' })
                return
              }
              const parts = await parseMultipart(req)
              const dirField = parts.find((p) => p.name === 'dirName')
              const dirName = (dirField ? dirField.data.toString('utf8') : '').trim()
              if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.includes('..') || /[^\w.\-]/.test(dirName)) {
                jsonResponse(res, 400, { error: 'invalid dirName' })
                return
              }
              const files = parts.filter((p) => p.filename)
              if (files.length === 0) {
                jsonResponse(res, 400, { error: 'no files' })
                return
              }
              // 必须包含 model3.json
              const hasModel3 = files.some((p) => p.filename.toLowerCase().endsWith('.model3.json'))
              if (!hasModel3) {
                jsonResponse(res, 400, { error: 'missing .model3.json in folder' })
                return
              }
              const targetDir = join(ASSETS_DIR, dirName)
              const abs = resolve(targetDir)
              if (abs !== ASSETS_DIR && !abs.startsWith(ASSETS_DIR + sep)) {
                jsonResponse(res, 400, { error: 'invalid dirName' })
                return
              }
              // 覆盖式写入：先清空旧目录
              try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
              mkdirSync(targetDir, { recursive: true })
              let written = 0
              for (const f of files) {
                // 用 webkitRelativePath（去掉首个目录段即 dirName）决定相对位置
                let relPath = f.webkitRelativePath || f.filename
                // webkitRelativePath 形如 dirName/sub/file —— 去掉开头的 dirName/
                const segs = relPath.split('/').filter(Boolean)
                if (segs.length > 1 && segs[0] === dirName) segs.shift()
                const rel = segs.join('/')
                const fpath = resolveWithin(targetDir, rel)
                if (!fpath) continue
                mkdirSync(dirname(fpath), { recursive: true })
                writeFileSync(fpath, f.data)
                written += 1
              }
              jsonResponse(res, 200, { ok: true, dirName, fileCount: written, modelUrl: `/plugins/dsh-live2d/assets/${dirName}/model.model3.json` })
            } catch (err) {
              jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) })
            }
          },
        }),
        'dsh-live2d: model upload endpoint',
      )

      // ── 模型自动扫描接口 ──────────────────────────────────
      // GET /plugins/dsh-live2d/models
      // 扫描 assets 目录下所有含 .model3.json 的子文件夹，自动生成模型列表；
      // 同时解析每个 model3.json 的 Motions/Expressions 作为动画映射下拉数据源。
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-live2d/models',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              jsonResponse(res, 405, { error: 'method not allowed' })
              return
            }
            if (!isLoopback(req.socket?.remoteAddress)) {
              jsonResponse(res, 403, { error: 'local access only' })
              return
            }
            const result = { assetsDir: ASSETS_DIR || '', models: [] }
            if (!ASSETS_DIR || !existsSync(ASSETS_DIR)) {
              jsonResponse(res, 200, result)
              return
            }
            // 读取内置的 model_list.json（若存在），将其动画映射/画布配置合并到扫描结果，
            // 使插件安装后无需手动配置即可使用默认动画映射。
            let presetMap = {}
            try {
              const presetPath = join(ASSETS_DIR, 'model_list.json')
              if (existsSync(presetPath)) {
                const preset = JSON.parse(readFileSync(presetPath, 'utf8'))
                const list = Array.isArray(preset.models) ? preset.models : []
                for (const m of list) {
                  if (m && m.url) {
                    // 归一化 url 子路径，便于和扫描得到的 url 匹配
                    const key = m.url.replace(/^\.?\//, '').replace(/^\/plugins\/dsh-live2d\/assets\//, '')
                    presetMap[key] = m
                  }
                }
              }
            } catch {}
            const findModel3 = (dir) => {
              let entries = []
              try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
              for (const e of entries) {
                if (e.isFile() && e.name.toLowerCase().endsWith('.model3.json')) return join(dir, e.name)
              }
              for (const e of entries) {
                if (e.isDirectory()) {
                  const found = findModel3(join(dir, e.name))
                  if (found) return found
                }
              }
              return null
            }
            let dirEntries = []
            try { dirEntries = readdirSync(ASSETS_DIR, { withFileTypes: true }) } catch {}
            for (const e of dirEntries) {
              if (!e.isDirectory()) continue
              const modelPath = findModel3(join(ASSETS_DIR, e.name))
              if (!modelPath) continue
              const rel = modelPath.slice(ASSETS_DIR.length).replace(/\\/g, '/').replace(/^\//, '')
              const url = '/plugins/dsh-live2d/assets/' + rel
              let groups = []
              let groupCounts = {}
              // groupMotions: { groupName: ['idle', 'tap', ...] } 取每个 motion 文件名（去扩展名）作展示
              let groupMotions = {}
              let expressions = []
              try {
                const model3 = JSON.parse(readFileSync(modelPath, 'utf8'))
                const fr = model3.FileReferences || {}
                const motions = fr.Motions || {}
                groups = Object.keys(motions)
                for (const g of groups) {
                  const entries = Array.isArray(motions[g]) ? motions[g] : []
                  groupCounts[g] = entries.length
                  groupMotions[g] = entries.map((m) => {
                    const f = (typeof m === 'string' ? m : (m.File || m.file || ''))
                    return f.split('/').pop().replace(/\.motion3\.json$/i, '').replace(/\.motion3$/i, '')
                  })
                }
                expressions = (fr.Expressions || []).map((x) =>
                  typeof x === 'string'
                    ? x.split('/').pop().replace(/\.exp3\.json$/i, '')
                    : (x.Name || (x.File || '')).toString())
              } catch {}
              // 用 url 子路径匹配内置 model_list.json 中的预设（动画映射/画布配置）
              const relKey = rel.replace(/^\/+/, '')
              const preset = presetMap[relKey] || {}
              result.models.push({
                name: preset.name || e.name,
                url,
                canvasWidth: preset.canvasWidth || 300,
                canvasHeight: preset.canvasHeight || 400,
                config: preset.config || { x: 0, y: 0, scaleX: 1, scaleY: 1 },
                groups,
                groupCounts,
                groupMotions,
                expressions,
                // 内置动画映射优先；用户后续在设置页的修改仍以 localStorage 为准
                animations: preset.animations || {},
              })
            }
            jsonResponse(res, 200, result)
          },
        }),
        'dsh-live2d: models scan endpoint',
      )

      // ── 本地文件路由 ──────────────────────────────────────────
      // 必须用 `kind: 'prefix'` 的具名路由，绝不能用 registerFallback：
      // fallback 座位是全局唯一的，spa 静态资源服务（dsh-host-frontend-static）
      // 已经占用了它。抢占之后 index.html / 所有未命中路由都会落到本插件的
      // handler 上，而它对这些路径不写任何响应 —— 请求永久挂住，页面打不开。
      //
      // webserver 的 prefix 匹配取最长前缀胜出，所以这两条比
      // dsh-client-modules 注册的 `/plugins` 更具体，会优先命中。
      const fileRoots = [
        { routePath: '/plugins/dsh-live2d/lib', dir: LIB_DIR },
        { routePath: '/plugins/dsh-live2d/assets', dir: ASSETS_DIR },
      ]

      for (const { routePath, dir } of fileRoots) {
        if (!dir) continue
        httpCtx.effect(
          () => httpCtx.webServer.register({
            kind: 'prefix',
            path: routePath,
            handler: (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405)
                res.end()
                return
              }
              // 与其他端点保持一致：仅允许本机访问
              if (!isLoopback(req.socket?.remoteAddress)) {
                res.writeHead(403)
                res.end('local access only')
                return
              }
              const urlPath = new URL(req.url || '/', 'http://localhost').pathname
              const rel = decodeURIComponent(urlPath.slice(routePath.length).replace(/^\//u, ''))
              const filePath = resolveWithin(dir, rel)
              if (!filePath) {
                res.writeHead(403)
                res.end('Forbidden')
                return
              }
              serveFile(res, filePath)
            },
          }),
          `dsh-live2d: ${routePath}`,
        )
      }
    })
  }

  // 清理
  ctx.effect(() => () => {
    offEvent?.()
    offStream?.()
    // 关闭并清空所有 SSE 连接，避免插件卸载/热重载后残留客户端（集合泄漏 + 僵尸连接）
    for (const res of stateClients) {
      try { res.end() } catch {}
    }
    stateClients.clear()
  }, 'dsh-live2d: cleanup')
}
