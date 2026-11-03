/**
 * dsh-multi-session — Host 半边。
 *
 * 主要职责：
 *   - `/digest`：读某个会话的事件日志、折叠成"我 ↔ AI"的对话条目，供并排列渲染；
 *   - `/prompt`：从面板里给别的会话发消息 / 停止运行；
 *   - `/report`：客户端异常落盘，开发期排查用；
 *   - dev 路由（`/probe` `/stamp` `/reload`）仅在 `dev: true` 时注册。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-multi-session'

/** webServer 用来挂路由；connection 用来做同源/鉴权闸门（裸路由不继承 RPC 鉴权）。 */
export const inject = ['webServer', 'connection']

const ROUTE = '/plugins/dsh-multi-session/probe'

/**
 * 开发期自助重载：`clientModules.rebuilt(id)` 是构建变化进入 Web 图表的唯一入口，
 * 图表 rev 一变，已打开的页面就会拿到新 bundle。改完 client.js 敲一下这条路由，
 * 不用每次 remove_bundle + install_bundle。
 */
const RELOAD_ROUTE = '/plugins/dsh-multi-session/reload'

const PACKAGE_ID = 'dsh-multi-session'

/**
 * 开发期自动重载：注入到 index.html 的轮询脚本。
 * 页面每 2 秒问一次「现在服务端发布的 bundle rev 是多少」，变了就 location.reload()。
 * 配合 STAMP_ROUTE（内部调用 clientModules.rebuilt 发布新字节），改完 client.js
 * 页面会自己刷新，不用手动 F5。由插件配置 `dev: true` 控制开关。
 */

const STAMP_ROUTE = '/plugins/dsh-multi-session/stamp'

/** 客户端异常落盘：页面一加载就装全局 error / unhandledrejection 钩子。 */
const ERROR_ROUTE = '/plugins/dsh-multi-session/report'

/**
 * 客户端异常落盘目录。
 * 用系统临时目录 + 插件名子目录，卸载即无残留。
 */
const DIAG_DIR = join(tmpdir(), 'dsh-multi-session')

const ERROR_FILE = join(DIAG_DIR, 'client-errors.json')

/** 探针落盘位置（仅 dev 时写入）。 */
const PROBE_FILE = join(DIAG_DIR, 'probe.json')

/** 最多保留多少次探针结果，避免反复刷新页面把文件撑大。 */
const MAX_PROBES = 20

/** 会话对话摘要：面板里点开某个会话时由 Host 侧读真实事件日志再折叠。 */
const DIGEST_ROUTE = '/plugins/dsh-multi-session/digest'
const PROMPT_ROUTE = '/plugins/dsh-multi-session/prompt'
const SEARCH_ROUTE = '/plugins/dsh-multi-session/search'
const PROMPT_TIMEOUT_MS = 15000
// 提问工具停下等答案时，会话的 running 仍然是 true —— 光看 running 分不出来。
const ASK_TOOL = 'ask_user_question'

/**
 * 每个会话的摘要缓存。readSurface 一次要 2.5 秒（整段日志重放），
 * 而面板是多列同时刷新，必须共享同一次结果，否则 Host 侧会被拖死。
 * 键是 `${mode}:${sessionId}:${limit}`；live 会话短 TTL，空闲会话长 TTL。
 */
const digestCache = new Map()
/**
 * live 会话缓存只留 800ms：客户端每 1.5 秒轮一次，如果 TTL 比轮询间隔还长，
 * 每次都会命中旧 payload，看起来就是"不实时"。留一点余量是为了让同一次
 * 刷新里的多个请求（多个并排列、诊断）共享一次重放，又不至于挡住新内容。
 */
const DIGEST_TTL_LIVE = 800
const DIGEST_TTL_IDLE = 60000
const DIGEST_CACHE_MAX = 200

/** 从消息体里抽纯文本：content 是 block 数组（type:'text'），同时兼容字符串形态。 */
function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 宿主往 user/message 里塞的"假用户消息"，第一行特征。
 * 这些都不是人打的字：运行时快照、时间戳、技能目录变更、压缩摘要。
 * 不过滤掉的话，并排视图里会混进几千字的系统文本，把真正的对话顶走。
 */
const INJECTED_HEADS = [
  'Current runtime context',
  'Time sampled while',
  'The available skill catalog changed',
  '[Compressed conversation section]',
  'Browser time zone for this request',
  'Your task is to',
]

/** 去掉 <system-reminder>…</system-reminder> 整段（技能目录、审批策略变更等都在里面）。 */
function dropSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim()
}

/**
 * 把一条 user/message 洗成"人真正打的那句话"。
 * 返回空串表示这条整条都是注入，不该显示。
 */
function cleanUserText(raw) {
  const text = dropSystemReminders(String(raw ?? ''))
  if (text === '') return ''
  const head = text.slice(0, 120)
  for (const marker of INJECTED_HEADS) {
    if (head.startsWith(marker)) return ''
  }
  return text
}

/**
 * 把原始事件日志折叠成面板能直接渲染的对话条目。
 * 同时兼容两种来源：
 *   - readSession / readEvent 的完整事件（有 turn/start、turn/end）
 *   - readSurface 的模型面事件（没有 turn/start）
 * 因此轮数在拿不到 turn/start 时退化为"用户消息条数"。
 *
 * 只保留 user/message 与 assistant/message 两种正文：并排视图的用途是
 * "一眼看清这几个会话各自聊到哪了"，工具调用、工具结果、思考过程都属于噪音，
 * 一律不搬进 items（Host 侧折叠阶段就丢掉，客户端只做兜底）。
 */
function foldDigest(events, limit) {
  const items = []
  let turns = 0
  let userTurns = 0
  let endReason = null
  // 「在等你」判定用的状态：
  // - 未决的审批（approval/asked 有、approval/decided 没有）
  // - 未返回的提问工具（ask_user_question 的 tool/call 有、tool/result 没有）
  const pendingCalls = new Map()
  const openApprovals = new Set()
  let lastWorkspaceSeq = 0
  let lastWorkspaceTurn = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const at = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'turn/start') {
      turns = Math.max(turns, Number(data.turn) || 0)
    } else if (event.type === 'turn/end') {
      endReason = data.reason !== null && typeof data.reason === 'object' ? String(data.reason.kind ?? '') : null
    } else if (event.type === 'user/message') {
      userTurns += 1
      const text = cleanUserText(textOfMessage(data)).trim()
      if (text !== '') items.push({ kind: 'user', text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text, at })
    } else if (event.type === 'assistant/message') {
      // 助手消息也可能带 system-reminder（极少见），一起洗掉。
      const text = dropSystemReminders(textOfMessage(data.message)).trim()
      if (text !== '') {
        items.push({ kind: 'assistant', text: text.length > 3000 ? `${text.slice(0, 3000)}…` : text, at })
      }
    } else if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const name = String(data.name ?? '')
      if (callId !== '') pendingCalls.set(callId, { name, at })
    } else if (event.type === 'tool/result') {
      const callId = String(data.message?.toolCallId ?? '')
      if (callId !== '') pendingCalls.delete(callId)
    } else if (event.type === 'approval/asked') {
      openApprovals.add(String(data.id ?? ''))
    } else if (event.type === 'approval/decided') {
      openApprovals.delete(String(data.id ?? ''))
    } else if (event.type === 'workspace/changes') {
      // seq 必须记住：workspaceChanges.summary() 只认这条事件的 seq。
      lastWorkspaceSeq = typeof event.seq === 'number' ? event.seq : 0
      lastWorkspaceTurn = Number(data.turn) || 0
    }
    // tool/call、tool/result 一律不搬进 items：并排视图只保留"我 ↔ AI 的对话正文"，
    // 工具调用和它们的输出对"看清这段聊了什么"是纯噪音。上面的状态跟踪只用于判定状态。
  }

  // 「在等你」的两种来源，任一成立即算：
  // 1) 有未决的审批请求（approval/asked 没有对应的 approval/decided）；
  // 2) 最后一个工具调用是 ask_user_question 且还没返回结果。
  let waiting = ''
  if (openApprovals.size > 0) {
    waiting = 'approval'
  } else {
    for (const call of pendingCalls.values()) {
      if (call.name === ASK_TOOL) {
        waiting = 'question'
        break
      }
    }
  }

  return {
    items: items.slice(-limit),
    turns: turns > 0 ? turns : userTurns,
    endReason,
    waiting,
    workspaceSeq: lastWorkspaceSeq,
    workspaceTurn: lastWorkspaceTurn,
  }
}

/**
 * 这一轮改了哪些文件。走 workspaceChanges.summary()，它只认 `workspace/changes`
 * 事件的 seq —— 也就是说必须用 foldDigest 顺带记下来的那个 seq，传别的 seq 一律 undefined。
 * 拿不到就返回 null，让客户端当成"没信息"而不是"改了 0 个文件"。
 */
function summarizeChanges(service, sessionId, folded) {
  const seq = Number(folded?.workspaceSeq) || 0
  if (seq <= 0) return null
  if (service === undefined || service === null || typeof service.summary !== 'function') return null
  let summary
  try {
    summary = service.summary(sessionId, seq)
  } catch {
    return null
  }
  if (summary === null || typeof summary !== 'object') return null
  const files = Array.isArray(summary.files) ? summary.files : []
  return {
    turn: Number(summary.turn) || 0,
    total: Number(summary.total) || files.length,
    added: Number(summary.added) || 0,
    deleted: Number(summary.deleted) || 0,
    files: files.slice(0, 40).map((file) => ({
      path: String(file?.path ?? ''),
      display: String(file?.display ?? file?.path ?? ''),
      added: Number(file?.added) || 0,
      deleted: Number(file?.deleted) || 0,
      binary: file?.binary === true,
      oversized: file?.oversized === true,
    })),
  }
}

/**
 * 请求是不是从本机发起的。只用于开发期自测与 loopback 放行，
 * 不参与任何业务鉴权判断（业务一律走 connection.requestRejection）。
 */
function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 逐个会话扫日志的兜底搜索。
 *
 * 为什么不用 sessionQuery.filterEvents：它每次要把整个会话完整重放一遍，
 * 实测单个会话 3.35 秒（那个会话 33513 个事件）。扫 40 个会话要 30 多秒。
 *
 * 为什么不能直接 readFile 就得到文本：DSH 的会话日志是**多个 zstd 帧拼接**的
 * （一个会话实测 281 帧），Node 的 zstdDecompressSync 只解第一帧就停，
 * createZstdDecompress 流式也只解第一帧。必须按 magic 0x28B52FFD 切开逐帧解。
 *
 * 实测：1041KB 的文件解成 2744KB 只要 33ms，全文扫 31ms —— 快 50 倍。
 */
const SESSION_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** sessionId → 日志文件路径。目录结构很浅、文件不多，缓存一次就够。 */
const sessionFileCache = new Map()

function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/** 在 sessions/<分组>/<uuid>/session.*.jsonl* 里找这个会话的日志文件。 */
function findSessionFile(sessionId) {
  const cached = sessionFileCache.get(sessionId)
  if (cached !== undefined) return cached
  const bare = String(sessionId).replace(/^session-/, '')
  const root = sessionsRoot()
  let found = null
  let groups = []
  try {
    groups = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return null
  }
  for (const group of groups) {
    const dir = join(root, group.name, bare)
    try {
      const files = readdirSync(dir).filter((name) => name.startsWith('session.') && name.includes('jsonl'))
      if (files.length > 0) {
        found = join(dir, files[0])
        break
      }
    } catch {
      // 这个分组里没有，继续下一个。
    }
  }
  sessionFileCache.set(sessionId, found)
  return found
}

/** 把多帧 zstd（或普通 jsonl）解成 UTF-8 文本。解不动的帧跳过，不让整次搜索失败。 */
function readSessionLogText(file) {
  const raw = readFileSync(file)
  let buffer = raw
  if (file.endsWith('.zstd')) {
    const offsets = []
    let at = 0
    while ((at = raw.indexOf(SESSION_MAGIC, at)) >= 0) {
      offsets.push(at)
      at += 4
    }
    const parts = []
    for (let index = 0; index < offsets.length; index += 1) {
      const start = offsets[index]
      const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length
      try {
        parts.push(zstdDecompressSync(raw.subarray(start, end)))
      } catch {
        // 单帧坏了就跳过。
      }
    }
    buffer = Buffer.concat(parts)
  }
  return buffer.toString('utf8')
}

/**
 * 哪些事件算"对话正文"。搜索只在这几类里找：
 * 用户看的是"哪句话在哪个会话里说过"，而不是内部状态变更。
 * 尤其 `agent/inbox/spliced` 会把同一条用户消息再抄一遍，不排除就会重复命中。
 */
const SEARCHABLE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * 一行日志的 JSON → 事件类型。解析失败返回空串（搜索照样能用，只是不给标签）。
 */
function eventTypeOf(line) {
  const at = line.indexOf('"type":"')
  if (at < 0) return ''
  const start = at + 8
  const end = line.indexOf('"', start)
  if (end < 0) return ''
  const value = line.slice(start, end)
  // 头一行是 {"type":"session",...}，不是事件。
  return value === 'session' ? '' : value
}

/**
 * 一行日志 → 可读正文。
 *
 * user/message 的正文在 `data.content[].text`，
 * assistant/message 的在 `data.message.content[].text`（多包一层 message）。
 * 抽不到就退回整行原文 —— 搜索要的是"这句话在哪"，不是精确的字段还原。
 */
function lineOfText(line) {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  try {
    const parsed = JSON.parse(trimmed)
    const data = parsed && typeof parsed === 'object' ? parsed.data : null
    if (data !== null && typeof data === 'object') {
      const owners = [data, data.message]
      for (const owner of owners) {
        if (owner === null || typeof owner !== 'object') continue
        const blocks = Array.isArray(owner.content) ? owner.content : null
        if (blocks === null) continue
        const texts = []
        for (const block of blocks) {
          if (block && typeof block === 'object' && typeof block.text === 'string' && block.text !== '') {
            texts.push(block.text)
          }
        }
        if (texts.length > 0) return texts.join('\n')
      }
      if (typeof data.text === 'string' && data.text !== '') return data.text
    }
  } catch {
    // 不是完整 JSON（多帧截断之类），退回原文。
  }
  return trimmed
}

/**
 * 从一段文本里截出命中处前后各 60 字，让结果能看出是"哪句话里命中的"。
 * 找不到就返回开头 160 字（有些事件的 text 是拼装出来的，下标可能对不上）。
 */
function snippetAround(text, needle) {
  const source = String(text ?? '')
  if (source === '') return ''
  const at = needle === '' ? -1 : source.toLowerCase().indexOf(needle)
  if (at < 0) return source.replace(/\s+/g, ' ').slice(0, 160)
  const start = Math.max(0, at - 60)
  const end = Math.min(source.length, at + needle.length + 60)
  return `${start > 0 ? '…' : ''}${source.slice(start, end).replace(/\s+/g, ' ')}${end < source.length ? '…' : ''}`
}

function sendJson(res, status, value, options = {}) {
  const body = JSON.stringify(value ?? null)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [key, headerValue] of Object.entries(options.headers ?? {})) {
    res.setHeader(key, headerValue)
  }
  res.end(body)
}

function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** 读取请求体（有上限，防止探针把内存吃满）。 */
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function appendError(payload) {
  let history = []
  try {
    const raw = await readFile(ERROR_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) history = parsed
  } catch {
    /* 文件不存在：从空历史开始 */
  }
  history.push({ at: new Date().toISOString(), payload })
  if (history.length > 40) history = history.slice(-40)
  await mkdir(dirname(ERROR_FILE), { recursive: true })
  await writeFile(ERROR_FILE, JSON.stringify(history, null, 2), 'utf8')
  return history.length
}

/** 注入到 index.html 的报错钩子：只报告，不阻断任何东西。 */
const buildAutoreloadTap = (initialRev) => `<script>
(function () {
  var INITIAL = ${JSON.stringify(initialRev || '')}
  var ROUTE = '${STAMP_ROUTE}'
  var reloads = 0
  var pending = null
  var pendingCount = 0
  var RELOAD_CAP = 30
  function check() {
    if (reloads > RELOAD_CAP) return
    fetch(ROUTE, { cache: 'no-store' })
      .then(function (response) { return response.json() })
      .then(function (body) {
        var rev = body && body.rev
        if (!rev || !INITIAL) { INITIAL = rev || INITIAL; return }
        if (rev === INITIAL) { pending = null; pendingCount = 0; return }
        // 防抖：连续两次看到同一个新 rev 才刷新，避免写入过程中的中间态反复刷新。
        if (pending === rev) {
          pendingCount++
          if (pendingCount >= 1) { reloads++; location.reload() }
        } else {
          pending = rev
          pendingCount = 0
        }
      })
      .catch(function () {})
  }
  setInterval(check, 2000)
})()
</script>`

/** 注入到 index.html 的报错钩子：只报告，不阻断任何东西。 */
const ERROR_TAP = `<script>
(function () {
  var ROUTE = '${ERROR_ROUTE}'
  var seen = 0
  function send(kind, message, extra) {
    if (seen++ > 20) return
    try {
      fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: kind,
          message: String(message || ''),
          url: location.href,
          extra: extra || null,
          at: new Date().toISOString()
        })
      }).catch(function () {})
    } catch (cause) {}
  }
  window.addEventListener('error', function (event) {
    send('error', event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 2000) : null
    })
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    send('rejection', reason && reason.message ? reason.message : reason, {
      stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : null
    })
  })
  send('boot', 'index loaded')
})()
</script>`

/**
 * 探针写入必须串行：客户端可能同时 POST 多条（诊断 + 一次性探针），
 * 并发 read-modify-write 会把 JSON 写坏（实测撞过一次）。
 */
let probeChain = Promise.resolve()

function appendProbe(payload) {
  probeChain = probeChain.then(async () => {
    let history = []
    try {
      const raw = await readFile(PROBE_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) history = parsed
    } catch {
      /* 文件不存在或已损坏：从空历史开始，不打断这次探针 */
    }
    history.push({ at: new Date().toISOString(), payload })
    if (history.length > MAX_PROBES) history = history.slice(-MAX_PROBES)
    await mkdir(dirname(PROBE_FILE), { recursive: true })
    await writeFile(PROBE_FILE, JSON.stringify(history, null, 2), 'utf8')
    return history.length
  })
  return probeChain
}

export function apply(ctx, config) {
  const get = (key) => (typeof ctx?.get === 'function' ? ctx.get(key) : undefined) ?? ctx?.[key]
  const webServer = get('webServer')
  // 开发期设施（探针上报、手动/自动重载）默认关闭，正式安装只留业务路由。
  // 需要在 profile 的 cordis.patch.yml 里给本插件配 `dev: true` 才打开。
  const DEV = config?.dev === true || process.env.DSH_MULTI_SESSION_DEV === '1'

  if (!webServer || typeof webServer.register !== 'function') {
    console.warn(
      `[dsh-multi-session] webServer service has no register(); the probe route ${ROUTE} is NOT registered.`,
    )
    return
  }

  const connectionOf = () => get('connection')

  // 页面一加载就装上全局报错钩子：客户端崩溃也能留下证据。
  // 同时把 DEV 标志交给客户端，诊断层据此决定要不要往 /probe 上报。
  // dev 打开时再叠加一个 rev 轮询，代码一变页面自己刷新。
  if (typeof webServer.tapIndex === 'function') {
    ctx.effect(() =>
      webServer.tapIndex((html) => {
        if (typeof html !== 'string' || !html.includes('</head>')) return html
        const flagTap = `<script>window.__DSH_MULTI_SESSION_DEV__=${DEV ? 'true' : 'false'}</script>`
        let injected = `${flagTap}${ERROR_TAP}`
        if (DEV) {
          const clientModules = get('clientModules')
          let rev = ''
          try {
            const graph = clientModules && typeof clientModules.graph === 'function' ? clientModules.graph() : null
            const entry = graph && Array.isArray(graph.entries)
              ? graph.entries.find((item) => item && item.id === PACKAGE_ID)
              : null
            rev = entry && entry.rev ? String(entry.rev) : ''
          } catch (error) {
            rev = ''
          }
          injected = `${flagTap}${buildAutoreloadTap(rev)}${ERROR_TAP}`
        }
        return html.replace('</head>', `${injected}</head>`)
      }),
    )
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: ERROR_ROUTE,
      async handler(req, res) {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, { ok: true, route: ERROR_ROUTE, errorFile: ERROR_FILE })
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const raw = await readBody(req, 256 * 1024)
          const payload = JSON.parse(raw)
          const kept = await appendError(payload)
          sendJson(res, 200, { ok: true, kept })
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  // 开发期路由统一收口：DEV 关闭时它们根本不存在，正式安装不会多出三个入口。
  const registerDev = (path, handler) => {
    if (!DEV) return
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler }))
  }

  registerDev(STAMP_ROUTE, async (req, res) => {
    const clientModules = get('clientModules')
    if (!clientModules || typeof clientModules.rebuilt !== 'function') {
      sendJson(res, 200, { rev: null })
      return
    }
    try {
      // rebuilt 会把磁盘上的新字节发布成新一代 bundle（元数据没变则原样返回旧图）。
      const rev = clientModules.rebuilt(PACKAGE_ID)
      sendJson(res, 200, { rev: rev ?? null })
    } catch (error) {
      sendJson(res, 200, { rev: null, error: String(error?.message ?? error) })
    }
  })

  registerDev(RELOAD_ROUTE, async (req, res) => {
    const gate = connectionOf()
    const rejection = gate === undefined ? 503 : gate.requestRejection(req)
    // 本机开发自助重载：只放行 loopback，其他来源照旧过鉴权闸门。
    const address = String(req?.socket?.remoteAddress ?? '')
    const loopback =
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    if (rejection !== undefined && !loopback) {
      sendJson(res, rejection, { error: 'not authorized' })
      return
    }
    const clientModules = get('clientModules')
    if (!clientModules || typeof clientModules.rebuilt !== 'function') {
      sendJson(res, 503, { error: 'clientModules.rebuilt unavailable' })
      return
    }
    try {
      const rev = clientModules.rebuilt(PACKAGE_ID)
      sendJson(res, 200, { ok: true, rev: rev ?? null })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  registerDev(ROUTE, async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()

    // GET 用来确认路由活着（排查"插件装了但没生效"）。
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, { ok: true, route: ROUTE, probeFile: PROBE_FILE })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD, POST' } })
      return
    }

    // 裸 WebServer 路由不继承 Connection 的鉴权围栏，必须自己过一遍。
    const gate = connectionOf()
    const rejection = gate === undefined ? 503 : gate.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error:
          rejection === 503
            ? 'authentication unavailable'
            : rejection === 401
              ? 'unauthorized'
              : 'forbidden',
      })
      return
    }

    try {
      const raw = await readBody(req)
      const payload = JSON.parse(raw)
      const kept = await appendProbe(payload)
      sendJson(res, 200, { ok: true, kept })
    } catch (error) {
      console.warn(`[dsh-multi-session] probe write failed: ${String(error?.message ?? error)}`)
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  })

  // 会话对话摘要：面板点开某个会话时拉一次，Host 侧读真实事件日志（客户端事件窗拿不到）。
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: DIGEST_ROUTE,
      async handler(req, res) {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD' } })
          return
        }

        const gate = connectionOf()
        const rejection = gate === undefined ? 503 : gate.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, {
            error:
              rejection === 503
                ? 'authentication unavailable'
                : rejection === 401
                  ? 'unauthorized'
                  : 'forbidden',
          })
          return
        }

        let params
        try {
          params = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams
        } catch {
          sendJson(res, 400, { error: 'bad url' })
          return
        }

        const sessionId = params.get('sessionId')
        if (sessionId === null || sessionId === '') {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const rawLimit = Number(params.get('limit'))
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 600) : 30

        const sessionQuery = get('sessionQuery')
        if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
          sendJson(res, 503, { error: 'sessionQuery.readSession unavailable' })
          return
        }

        try {
          const mode = params.get('mode') || 'observe'
          const startedAt = Date.now()
          const live = params.get('live') === '1'
          const noCache = params.get('fresh') === '1'

          // 面板会同时刷新多列，同一次 readSurface 不该被重复执行。
          // v3：折叠规则变了（只剩我↔AI 正文），旧缓存必须失效。
          // live 必须进键：运行中的短 TTL 缓存和空闲的长 TTL 缓存不能互相污染，
          // 否则会话刚跑完那一刻，空闲请求会命中"助手最后一句话还没写进去"的旧 payload。
          const cacheKey = `v5:${mode}:${live ? 'live' : 'idle'}:${sessionId}:${limit}`
          const ttl = live ? DIGEST_TTL_LIVE : DIGEST_TTL_IDLE
          if (!noCache) {
            const hit = digestCache.get(cacheKey)
            if (hit !== undefined && startedAt - hit.at < ttl) {
              sendJson(res, 200, { ...hit.payload, ms: Date.now() - startedAt, cached: true, age: startedAt - hit.at })
              return
            }
          }

          const remember = (payload) => {
            digestCache.set(cacheKey, { at: Date.now(), payload })
            if (digestCache.size > DIGEST_CACHE_MAX) {
              // 简单淘汰：删掉最早插入的一条，够用了。
              const oldest = digestCache.keys().next()
              if (oldest.done !== true) digestCache.delete(oldest.value)
            }
            sendJson(res, 200, { ...payload, cached: false })
          }

          // 默认取数路径：observeSession 直接给内存/已备好的事件快照，不做 replay 校验，
          // 实测实时会话 ~5ms、139 轮历史会话 ~84ms；readSurface 同条件下要 300ms/2.8s。
          // 只有 observe 拿不到事件时才退回 readSurface。
          if (mode === 'observe') {
            let events = []
            let source = null
            let cursor = null
            let usedObserve = false
            try {
              const lease = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
              if (lease && Array.isArray(lease.events) && lease.events.length > 0) {
                events = lease.events
                source = lease.source ?? null
                cursor = lease.cursor ?? null
                usedObserve = true
              }
              // 只读快照，不 retain（retain 会让会话被插件长期持有），用完即释放。
              if (lease && typeof lease.dispose === 'function') {
                try {
                  lease.dispose()
                } catch {
                  // 忽略：释放失败不影响本次结果。
                }
              }
            } catch {
              // observe 不可用就走下面的兜底。
            }

            if (!usedObserve) {
              const surface = await sessionQuery.readSurface(sessionId)
              events = surface && Array.isArray(surface.events) ? surface.events : []
              source = 'surface'
            }

            const folded = foldDigest(events, limit)
            const changes = summarizeChanges(get('workspaceChanges'), sessionId, folded)
            remember({
              ok: true,
              mode: 'observe',
              sessionId,
              ms: Date.now() - startedAt,
              eventCount: events.length,
              source,
              cursor,
              turns: folded.turns,
              endReason: folded.endReason,
              waiting: folded.waiting,
              changes,
              items: folded.items,
            })
            return
          }

          if (mode === 'list') {
            const records = await sessionQuery.listEvents(sessionId)
            const list = Array.isArray(records) ? records : []
            sendJson(res, 200, {
              ok: true,
              mode,
              sessionId,
              ms: Date.now() - startedAt,
              count: list.length,
              tail: list.slice(-6).map((record) => ({ seq: record.seq, type: record.type })),
            })
            return
          }

          if (mode === 'surface') {
            const surface = await sessionQuery.readSurface(sessionId)
            const events = surface && Array.isArray(surface.events) ? surface.events : []
            const folded = foldDigest(events, limit)
            remember({
              ok: true,
              mode,
              sessionId,
              ms: Date.now() - startedAt,
              eventCount: events.length,
              turns: folded.turns,
              endReason: folded.endReason,
              items: folded.items,
            })
            return
          }

          if (mode === 'event') {
            const listStart = Date.now()
            const records = await sessionQuery.listEvents(sessionId)
            const list = Array.isArray(records) ? records : []
            const listMs = Date.now() - listStart
            const wanted = new Set(['user/message', 'assistant/message', 'tool/call', 'turn/end'])
            const interesting = list.filter((record) => wanted.has(record.type))
            const tail = interesting.slice(-Math.min(limit, 4))
            const readStart = Date.now()
            const collected = []
            const perCall = []
            for (const record of tail) {
              const oneStart = Date.now()
              try {
                const window = await sessionQuery.readEvent({ sessionId, seq: record.seq, before: 0, after: 0 })
                if (window && window.target) collected.push(window.target)
              } catch {
                // 单条读失败就跳过，不让整次摘要崩掉。
              }
              perCall.push(Date.now() - oneStart)
            }
            const readMs = Date.now() - readStart
            const folded = foldDigest(collected, limit)
            remember({
              ok: true,
              mode,
              sessionId,
              ms: Date.now() - startedAt,
              listMs,
              readMs,
              perCall,
              eventCount: collected.length,
              turns: folded.turns,
              endReason: folded.endReason,
              items: folded.items,
            })
            return
          }

          const snapshot = await sessionQuery.readSession(sessionId)
          const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
          const folded = foldDigest(events, limit)
          remember({
            ok: true,
            mode: 'log',
            sessionId,
            header: snapshot && snapshot.session ? snapshot.session : null,
            eventCount: events.length,
            ms: Date.now() - startedAt,
            turns: folded.turns,
            endReason: folded.endReason,
            items: folded.items,
          })
        } catch (error) {
          sendJson(res, 404, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  // 跨会话全文搜索：sessionController.search 的官方语义是
  // "Search visible Session content without resuming an Agent"，
  // 也就是不会激活会话、不烧 token，找到的只是历史上已经写下的文字。
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: SEARCH_ROUTE,
      async handler(req, res) {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'GET, HEAD' } })
          return
        }

        let params
        try {
          params = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams
        } catch {
          sendJson(res, 400, { error: 'bad url' })
          return
        }

        // 开发期自测：确认"索引关掉之后磁盘扫描到底能不能用"。
        // 只在本机（回环）+ dev 开关同时满足时才开 —— 这条分支能把会话正文原文吐出来，
        // 生产环境绝不能留这个口子。
        if (params.get('selftest') === '1' && DEV && isLoopback(req)) {
          const probeId = (params.get('sessionId') ?? '').trim()
          const probeQuery = (params.get('q') ?? '').trim()
          if (probeId === '' || probeQuery === '') {
            sendJson(res, 400, { error: 'selftest needs ?q=&sessionId=' })
            return
          }
          try {
            const startedAt = Date.now()
            const file = findSessionFile(probeId)
            const findMs = Date.now() - startedAt
            if (file === null) {
              sendJson(res, 200, { ok: true, selftest: true, file: null, findMs, note: 'no log file for this session' })
              return
            }
            const readStart = Date.now()
            const text = readSessionLogText(file)
            const readMs = Date.now() - readStart
            const needle = probeQuery.toLowerCase()
            const hits = []
            let count = 0
            for (const line of text.split('\n')) {
              if (line === '') continue
              if (!line.toLowerCase().includes(needle)) continue
              const type = eventTypeOf(line)
              if (!SEARCHABLE_TYPES.has(type)) continue
              count += 1
              if (hits.length < 3) hits.push({ type, snippet: snippetAround(lineOfText(line), needle) })
            }
            sendJson(res, 200, {
              ok: true,
              selftest: true,
              file: file.replace(/^.*[\\/]/, ''),
              findMs,
              readMs,
              sourceBytes: text.length,
              count,
              hits,
            })
          } catch (error) {
            sendJson(res, 502, { error: String(error?.message ?? error) })
          }
          return
        }

        const gate = connectionOf()
        const rejection = gate === undefined ? 503 : gate.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, {
            error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
          })
          return
        }

        const query = (params.get('q') ?? '').trim()
        if (query === '') {
          sendJson(res, 400, { error: 'q is required' })
          return
        }

        const sessionController = get('sessionController')

        // 1) 优先用官方索引：快、带排序，而且覆盖全部可见会话。
        if (sessionController !== undefined && typeof sessionController.search === 'function') {
          const probe = new AbortController()
          const probeTimer = setTimeout(() => probe.abort(), 8000)
          try {
            const startedAt = Date.now()
            const value = await sessionController.search({ query }, probe.signal)
            const items = Array.isArray(value?.items) ? value.items : []
            sendJson(res, 200, {
              ok: true,
              query,
              via: 'index',
              ms: Date.now() - startedAt,
              hasMore: value?.hasMore === true,
              items: items.slice(0, 60).map((item) => ({
                sessionId: String(item?.sessionId ?? ''),
                snippet: String(item?.snippet ?? '').slice(0, 400),
              })),
            })
            return
          } catch {
            // 这个部署把索引关掉了（openAt: "never"）→ 静默落到下面的自建扫描。
          } finally {
            clearTimeout(probeTimer)
          }
        }

        // 2) 兜底：直接读磁盘上的会话日志。
        //
        // this deployment 把 session-query 索引配成 openAt: "never" 时，官方
        // sessionController.search 直接报 "session search is disabled"。
        // sessionQuery.filterEvents 虽然可用，但每个会话要完整重放，实测 3.35 秒/会话；
        // 直接解 zstd 帧再扫只要 64ms/会话（差 50 倍），所以走这条。
        const ids = (params.get('sessions') ?? '')
          .split(',')
          .map((one) => one.trim())
          .filter((one) => one !== '')
          .slice(0, 60)
        if (ids.length === 0) {
          sendJson(res, 400, {
            error: 'session search index is disabled in this deployment; pass ?sessions=id1,id2 to scan those sessions directly',
          })
          return
        }

        const needle = query.toLowerCase()
        const startedAt = Date.now()
        const results = []
        let scanned = 0
        let unreadable = 0
        const CONCURRENCY = 4
        let cursor = 0
        const worker = async () => {
          while (cursor < ids.length) {
            const index = cursor
            cursor += 1
            const sessionId = ids[index]
            try {
              const file = findSessionFile(sessionId)
              scanned += 1
              if (file === null) {
                unreadable += 1
                continue
              }
              const text = readSessionLogText(file)
              if (text === '') continue
              const hits = []
              let count = 0
              for (const line of text.split('\n')) {
                if (line === '') continue
                if (!line.toLowerCase().includes(needle)) continue
                const type = eventTypeOf(line)
                if (!SEARCHABLE_TYPES.has(type)) continue
                count += 1
                if (hits.length < 4) {
                  hits.push({ type, role: type === 'user/message' ? '我' : '助手', snippet: snippetAround(lineOfText(line), needle) })
                }
              }
              if (count > 0) results.push({ sessionId, count, hits })
            } catch {
              // 单个会话读失败就跳过，不让整次搜索崩掉。
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))
        results.sort((left, right) => right.count - left.count)
        sendJson(res, 200, {
          ok: true,
          query,
          via: 'scan',
          ms: Date.now() - startedAt,
          scanned,
          unreadable,
          hasMore: ids.length >= 60,
          items: results.slice(0, 60).map((item) => ({
            sessionId: item.sessionId,
            snippet: item.hits[0] ? item.hits[0].snippet : '',
            count: item.count,
            hits: item.hits,
          })),
        })
      },
    }),
  )

  // 在面板里直接给别的会话发消息 / 打断它，不用先切过去。
  // 走 sessionController（Host 侧唯一能 admission 一条 prompt 的入口）。
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: PROMPT_ROUTE,
      async handler(req, res) {
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' }, { headers: { allow: 'POST' } })
          return
        }

        const gate = connectionOf()
        const rejection = gate === undefined ? 503 : gate.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }

        let body
        try {
          body = JSON.parse(await readBody(req, 256 * 1024))
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }

        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const text = typeof body?.text === 'string' ? body.text : ''
        const action = body?.action === 'cancel' ? 'cancel' : 'prompt'
        if (sessionId === '') {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }

        const sessionController = get('sessionController')
        if (sessionController === undefined) {
          sendJson(res, 503, { error: 'sessionController unavailable' })
          return
        }

        try {
          if (action === 'cancel') {
            if (typeof sessionController.cancel !== 'function') {
              sendJson(res, 503, { error: 'sessionController.cancel unavailable' })
              return
            }
            const value = sessionController.cancel({ sessionId })
            sendJson(res, 200, { ok: true, action, sessionId, accepted: value?.accepted === true })
            return
          }

          if (text.trim() === '') {
            sendJson(res, 400, { error: 'text is required' })
            return
          }
          if (typeof sessionController.prompt !== 'function') {
            sendJson(res, 503, { error: 'sessionController.prompt unavailable' })
            return
          }

          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS)
          try {
            const value = await sessionController.prompt(
              {
                // requestId 只用于去重/回执，插件自己发起的请求给个带前缀的唯一值即可。
                requestId: `dsh-multi-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                sessionId,
                // queue：排进收件箱，不打断正在跑的回合（默认，最安全）。
                // steer：立刻插话打断当前回合，由调用方显式要求。
                mode: body?.mode === 'steer' ? 'steer' : 'queue',
                content: [{ type: 'text', text }],
              },
              controller.signal,
            )
            sendJson(res, 200, { ok: true, action: 'prompt', sessionId, accepted: value?.accepted === true })
          } finally {
            clearTimeout(timer)
          }
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      },
    }),
  )
}
