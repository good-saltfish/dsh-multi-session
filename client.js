/**
 * dsh-multi-session — Client 半边。
 *
 * Phase 1：在会话内注册一个「多会话」视图，把所有会话按工作区分组列出来，
 * 一眼看到谁在跑、谁刚跑完还没看、谁闲着；点一下直接跳过去。
 * 针对的痛点：开了多个会话在跑，跑完了不知道，还得一个个点开找。
 *
 * ── 数据来源（2026-10-30 实测，别再猜）────────────────────────────────
 *   props.useSessions(selector) →
 *     { ids: SessionId[], byId: Record<SessionId, SessionMeta>,
 *       phase: 'ready'|..., projectionsBySession: Record<SessionId, {values,state,error}> }
 *
 *     SessionMeta = { id, title, displayTitle, running: boolean,
 *                     retainedBy, blank, updatedAt: number(ms), formatStatus,
 *                     projectionValues, cwd }
 *     ← running / cwd / updatedAt / displayTitle 都在这儿，这是主数据源。
 *
 *     projectionsBySession[id].values = { title, goal, tokenUsage, contextPressure,
 *       inbox, sessionStats, turnOutline[], agentPreset, userQuestions, todos,
 *       modelSelection, subagentCatalog[], workingDirectory, ... }
 *     ← 轮数、子代理数、token、模型从这儿取，只当补充。
 *
 *   props.useWorkspaces(selector) →
 *     { items: [{ workspaceId, path, title, sessionIds[], createdAt, updatedAt }],
 *       archivedSessionIds: SessionId[], pinnedSessionIds: SessionId[],
 *       state, phase, error }
 *     ← 只有分组信息和归档名单，没有运行态。
 *
 * 两个 hook 都是实时推送快照：不轮询、不自建库、不落盘。
 *
 * ── 「待查看」标记 ─────────────────────────────────────────────────
 * running 由 true → false 的瞬间标记「刚完成」（内存态 + localStorage 持久化）。
 * 只做面板里的被动标记，不弹任何浮层/通知/标题角标。
 * 「点开就算看过」由 finishedAt 清除 + lastSeen 基线推进两件事一起保证。
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAG = '[dsh-multi-session]'
    const ROUTE = '/plugins/dsh-multi-session/probe'
    const VIEW_ID = 'multi-session'

    /**
     * 开发期诊断层开关：Host 在 index.html 注入 window.__DSH_MULTI_SESSION_DEV__。
     * 正式安装（未开 dev）时为 false，不注册诊断浮层，也不往 /probe 上报。
     */
    const DIAG = (() => {
      try {
        return typeof window !== 'undefined' && window.__DSH_MULTI_SESSION_DEV__ === true
      } catch {
        return false
      }
    })()

    /** 诊断代号：每次改动递增，用来区分浏览器里跑的是哪一代 bundle。 */
    const BUILD = 'panel-v51'

    /** apply() 的 ctx，用于点击跳转。 */
    let rootCtx

    /** 选择器必须是模块级稳定引用，否则快照订阅每帧重订（轻则抖，重则死循环）。 */
    const identity = (state) => state

    const EMPTY = Object.freeze([])

    /** 用户当前正在看的会话 id，由 ActiveSessionProbe 在会话头部写入。 */
    let activeSessionId = ''

    /** Phase 2 探针只跑一次。 */
    let retainProbed = false
    let digestProbed = false
let promptProbed = false

    /* ------------------------------------------------------------------ *
     * 完成检测
     * ------------------------------------------------------------------ */

    const previousRunning = new Map()
    const finishedAt = new Map()
    /** 首帧只当基线：不能把历史会话全标成"刚完成"。 */
    let primed = false

    /**
     * 「哪些会话完成了、我还没看」必须活过页面刷新。
     * 只放内存的话，开发期一次热重载就把待查看列表清空，等于这个功能白做。
     */
    const FINISHED_STORE = 'dsh-multi-session:finished:v1'
    const FINISHED_STORE_MAX = 200
    /** 上次看到每个会话时的 updatedAt，用来补标"关页面期间完成"的会话。 */
    const SEEN_STORE = 'dsh-multi-session:seen:v1'
    const SEEN_STORE_MAX = 400
    const lastSeen = new Map()
    /** 冷启动补标最多补这么多个，避免几百个子代理会话把浮标刷爆。 */
    const CATCHUP_MAX = 10
    let lastSeenWriteAt = 0

    function loadFinished() {
      try {
        const raw = window.localStorage.getItem(FINISHED_STORE)
        if (raw === null || raw === '') return
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return
        for (const key of Object.keys(parsed)) {
          const value = Number(parsed[key])
          if (Number.isFinite(value) && value > 0) finishedAt.set(key, value)
        }
      } catch {
        // localStorage 不可用（隐私模式等）就退化成纯内存，不影响主功能。
      }
    }

    function saveFinished() {
      try {
        const entries = Array.from(finishedAt.entries())
        const kept = entries.length > FINISHED_STORE_MAX ? entries.slice(-FINISHED_STORE_MAX) : entries
        const plain = {}
        for (const [key, value] of kept) plain[key] = value
        window.localStorage.setItem(FINISHED_STORE, JSON.stringify(plain))
      } catch {
        // 同上：存不下就只保留内存态。
      }
    }

    loadFinished()

    function loadSeen() {
      try {
        const raw = window.localStorage.getItem(SEEN_STORE)
        if (raw === null || raw === '') return
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return
        for (const key of Object.keys(parsed)) {
          const value = Number(parsed[key])
          if (Number.isFinite(value) && value > 0) lastSeen.set(key, value)
        }
      } catch {
        // 同上，读不到就退化成"没有基线"，不会误标。
      }
    }

    function saveSeen(force) {
      const now = Date.now()
      if (!force && now - lastSeenWriteAt < 30000) return
      lastSeenWriteAt = now
      try {
        let entries = Array.from(lastSeen.entries())
        if (entries.length > SEEN_STORE_MAX) {
          // 超量时保留"最近更新"的那批，而不是插入顺序的尾巴——
          // 否则先遍历到的会话基线会被丢掉，冷启动补标对它们永远失效。
          entries.sort((left, right) => right[1] - left[1])
          entries = entries.slice(0, SEEN_STORE_MAX)
        }
        const plain = {}
        for (const [key, value] of entries) plain[key] = value
        window.localStorage.setItem(SEEN_STORE, JSON.stringify(plain))
      } catch {
        // 存不下不影响主功能。
      }
    }

    loadSeen()

    /** 钉住的会话：退出面板再进来要还在，否则每次都得重新挑三个。 */
    const PINNED_STORE = 'dsh-multi-session:pinned:v1'

    function loadPinned() {
      try {
        const raw = window.localStorage.getItem(PINNED_STORE)
        if (raw === null || raw === '') return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const ids = []
        for (const value of parsed) {
          if (typeof value === 'string' && value !== '' && ids.indexOf(value) < 0) ids.push(value)
        }
        return ids.slice(0, 3)
      } catch {
        // 读不到就当没钉过，不影响主功能。
        return []
      }
    }

    function savePinned(ids) {
      try {
        window.localStorage.setItem(PINNED_STORE, JSON.stringify(Array.isArray(ids) ? ids : []))
      } catch {
        // 存不下就只在本次会话里生效。
      }
    }

    /**
     * 冷启动补标：页面关着的那段时间里跑完的会话，光靠"看着 running 变 false"是发现不了的。
     * 用上次记住的 updatedAt 对比——时间往前走了、现在不在跑、又不是当前会话，就当作"刚完成"。
     */
    function catchUpFinished(entries) {
      const candidates = []
      for (const entry of entries) {
        if (entry.blank || entry.running) continue
        const seen = lastSeen.get(entry.id)
        if (seen === undefined) continue
        if (!(entry.updatedAt > seen)) continue
        if (finishedAt.has(entry.id)) continue
        candidates.push(entry)
      }
      if (candidates.length === 0) return false
      candidates.sort((left, right) => right.updatedAt - left.updatedAt)
      for (const entry of candidates.slice(0, CATCHUP_MAX)) {
        finishedAt.set(entry.id, entry.updatedAt)
      }
      saveFinished()
      return true
    }

    function detectFinished(entries) {
      let changed = false
      const coldStart = !primed
      // 必须先补标再刷新基线：catchUpFinished 依赖"旧 lastSeen vs 新 updatedAt"的差，
      // 如果先更新 lastSeen，差值就被抹平，补标永远为空。
      if (coldStart) {
        primed = true
        if (catchUpFinished(entries)) changed = true
      }
      for (const entry of entries) {
        const previous = previousRunning.get(entry.id)
        previousRunning.set(entry.id, entry.running)
        if (entry.updatedAt > 0) lastSeen.set(entry.id, entry.updatedAt)
        if (coldStart) continue
        if (previous === true && entry.running === false && !finishedAt.has(entry.id)) {
          finishedAt.set(entry.id, Date.now())
          changed = true
        }
      }
      saveSeen(coldStart)
      if (changed) saveFinished()
      return changed
    }

    /* ------------------------------------------------------------------ *
     * 快照解析
     * ------------------------------------------------------------------ */

    function basename(path) {
      if (!path) return ''
      const parts = String(path).split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : String(path)
    }

    function readNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0
    }

    function tokenTotal(usage) {
      if (!usage || typeof usage !== 'object') return 0
      return (
        readNumber(usage.uncachedInputTokens) +
        readNumber(usage.outputTokens) +
        readNumber(usage.cacheReadTokens) +
        readNumber(usage.cacheWriteTokens)
      )
    }

    /**
     * 模型名。实测形状（2026-10-30）：
     * { lastUsed: { provider, model, reasoningEffort }, next: { provider, model, reasoningEffort } }
     * 优先取 next（即将用于下一轮的），退回 lastUsed，再退回扁平字段。
     */
    function modelLabel(selection) {
      if (!selection) return ''
      if (typeof selection === 'string') return selection
      if (typeof selection !== 'object') return ''
      const layers = [selection.next, selection.lastUsed, selection]
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object') continue
        for (const key of ['model', 'modelId', 'id', 'name']) {
          const candidate = layer[key]
          if (typeof candidate === 'string' && candidate) return candidate
        }
      }
      return ''
    }

    /** 工作区索引：sessionId → { workspaceId, title, path }，外加归档名单。 */
    function readWorkspaces(workspaces) {
      const bySession = new Map()
      const byPath = new Map()
      const groups = []
      const archived = new Set()
      if (!workspaces || typeof workspaces !== 'object') {
        return { bySession, byPath, groups, archived }
      }
      const items = Array.isArray(workspaces.items) ? workspaces.items : EMPTY
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const group = {
          workspaceId: item.workspaceId,
          path: typeof item.path === 'string' ? item.path : '',
          title: typeof item.title === 'string' && item.title ? item.title : '',
          sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : EMPTY,
        }
        groups.push(group)
        for (const sessionId of group.sessionIds) bySession.set(sessionId, group)
        // 子代理会话（parentId 非空）通常不进任何 workspace 的 sessionIds，
        // 但它们带着真实 cwd；按 cwd 归回工作区，比单开一个"其他"桶更符合直觉。
        if (group.path) {
          const key = group.path.toLowerCase()
          if (!byPath.has(key)) byPath.set(key, group)
        }
      }
      if (Array.isArray(workspaces.archivedSessionIds)) {
        for (const sessionId of workspaces.archivedSessionIds) archived.add(sessionId)
      }
      return { bySession, byPath, groups, archived }
    }

    /**
     * 会话条目。主数据来自 useSessions().byId，投影值来自 projectionsBySession。
     * 不遍历 byId 全表——以 ids 为准，避免把残留键也画出来。
     */
    function readEntries(sessions, workspaceIndex) {
      if (!sessions || typeof sessions !== 'object') return EMPTY
      const byId = sessions.byId
      if (!byId || typeof byId !== 'object') return EMPTY
      const ids = Array.isArray(sessions.ids) ? sessions.ids : Object.keys(byId)
      const projections =
        sessions.projectionsBySession && typeof sessions.projectionsBySession === 'object'
          ? sessions.projectionsBySession
          : {}

      const entries = []
      for (const sessionId of ids) {
        const meta = byId[sessionId]
        if (!meta || typeof meta !== 'object') continue
        const projection = projections[sessionId]
        const values =
          projection && projection.values && typeof projection.values === 'object'
            ? projection.values
            : meta.projectionValues && typeof meta.projectionValues === 'object'
              ? meta.projectionValues
              : null

        const cwd = typeof meta.cwd === 'string' ? meta.cwd : values && values.workingDirectory
        const cwdText = typeof cwd === 'string' ? cwd : ''
        const group =
          workspaceIndex.bySession.get(sessionId) ||
          (cwdText ? workspaceIndex.byPath.get(cwdText.toLowerCase()) : undefined)
        const turnOutline = values && Array.isArray(values.turnOutline) ? values.turnOutline : EMPTY
        const subagents = values && Array.isArray(values.subagentCatalog) ? values.subagentCatalog : EMPTY

        entries.push({
          id: typeof meta.id === 'string' ? meta.id : sessionId,
          title:
            (typeof meta.displayTitle === 'string' && meta.displayTitle) ||
            (typeof meta.title === 'string' && meta.title) ||
            (values && typeof values.title === 'string' && values.title) ||
            '(无标题)',
          running: meta.running === true,
          updatedAt: readNumber(meta.updatedAt),
          cwd: cwdText,
          blank: meta.blank === true,
          parentId: typeof meta.parentId === 'string' ? meta.parentId : '',
          origin: typeof meta.origin === 'string' ? meta.origin : '',
          archived: workspaceIndex.archived.has(sessionId),
          groupId: group ? group.workspaceId : '',
          groupTitle: group ? group.title || basename(group.path) || '工作区' : '',
          groupPath: group ? group.path : '',
          turns: turnOutline.length,
          subagents: subagents.length,
          tokens: tokenTotal(values && values.tokenUsage),
          model: modelLabel(values && values.modelSelection),
          finishedAt: finishedAt.get(sessionId) || 0,
        })
      }
      return entries
    }

    /* ------------------------------------------------------------------ *
     * 交互
     * ------------------------------------------------------------------ */

    function getService(name) {
      if (!rootCtx) return undefined
      try {
        return typeof rootCtx.get === 'function' ? rootCtx.get(name) : rootCtx[name]
      } catch (cause) {
        return undefined
      }
    }

    /**
     * 跳转到某个会话。SessionTarget 的公开形状没有文档，两种写法都试。
     * 失败只告警，不打断面板。
     */
    function openSession(sessionId) {
      const ui = getService('uiWorkspace')
      if (!ui || typeof ui.openSession !== 'function') {
        console.warn(`${TAG} uiWorkspace.openSession unavailable`)
        return
      }
      // SessionTarget = SessionId | SubagentAddress：普通会话就是裸 id 字符串，
      // 传 { sessionId } 这种对象既不是合法 id 也不是地址，会被当成"没有目标"而落到新建会话。
      // 子代理会话要换成它自己的地址对象才认得。
      let target = sessionId
      try {
        const sessions = getService('sessions')
        if (sessions && typeof sessions.subagentAddress === 'function') {
          const address = sessions.subagentAddress(sessionId)
          if (address !== undefined && address !== null) target = address
        }
      } catch {
        // 拿不到地址就按普通会话处理。
      }
      try {
        ui.openSession(target)
      } catch (cause) {
        try {
          ui.openSession(sessionId)
        } catch (fallbackCause) {
          console.warn(`${TAG} openSession failed`, cause, fallbackCause)
        }
      }
    }

    function post(payload) {
      try {
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch (cause) {
        /* 诊断失败绝不影响面板 */
      }
    }

    /* ------------------------------------------------------------------ *
     * 格式化
     * ------------------------------------------------------------------ */

    function relativeTime(timestamp) {
      if (!timestamp) return ''
      const delta = Date.now() - timestamp
      if (delta < 0) return '刚刚'
      const seconds = Math.floor(delta / 1000)
      if (seconds < 45) return '刚刚'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${Math.max(minutes, 1)} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      if (days < 30) return `${days} 天前`
      return `${Math.floor(days / 30)} 个月前`
    }

    function formatTokens(tokens) {
      if (!tokens) return ''
      if (tokens < 1000) return `${tokens} tok`
      if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k tok`
      return `${(tokens / 1000000).toFixed(2)}M tok`
    }

    /** 排序权重：运行中 → 刚完成 → 其余。 */
    function rankOf(entry) {
      if (entry.running) return 0
      if (entry.finishedAt) return 1
      return 2
    }

    /* ------------------------------------------------------------------ *
     * 样式：只用 DSH 主题 alias token，深浅色自动跟随
     * ------------------------------------------------------------------ */

    const RUNNING_COLOR = '#22a06b'
    const FINISHED_COLOR = '#3b6cf6'

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flex: '0 0 auto',
        flexWrap: 'wrap',
      },
      headerTitle: { fontWeight: 600, fontSize: 14 },
      counter: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      spacer: { flex: '1 1 auto' },
      button: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 9px',
        fontSize: 12,
        cursor: 'pointer',
      },
      body: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '6px 0 20px' },
      group: { padding: '8px 14px 2px' },
      groupHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
      },
      groupName: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      groupPath: {
        fontSize: 11,
        opacity: 0.65,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 420,
      },
      card: {
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        padding: '8px 10px',
        marginBottom: 6,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
      },
      cardRunning: { borderColor: 'rgba(34,160,107,0.45)' },
      cardFinished: { borderColor: 'rgba(59,108,246,0.45)' },
      cardLast: {
        marginTop: 2,
        fontSize: 11,
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-secondary)',
        opacity: 0.9,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      cardBody: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 auto' },
      cardTitleRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
      cardTitle: {
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
      badge: {
        flex: '0 0 auto',
        fontSize: 10.5,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid currentColor',
        opacity: 0.9,
      },
      metaRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12.5,
        lineHeight: 1.7,
      },
      /* 并排视图（Phase 2） */
      split: {
        display: 'flex',
        flex: 1,
        minHeight: 0,
        gap: 10,
        padding: '0 12px 12px',
      },
      listPane: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: 'min(56vh, 560px)',
        overflow: 'auto',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
        flex: '0 0 300px',
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        paddingRight: 10,
      },
      listPaneWide: {
        flex: 1,
        borderRight: 'none',
        paddingRight: 0,
      },
      board: {
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        gap: 10,
        overflowX: 'auto',
      },
      boardCol: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0',
        minWidth: 330,
        minHeight: 0,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      boardColHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 9px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        flex: '0 0 auto',
      },
      boardColTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      boardColMeta: {
        flex: '0 0 auto',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      boardScroll: {
        flex: 1,
        minHeight: 0,
        // 父级高度一旦是 auto（插槽容器不给确定高度），flex:1 就约束不住，
        // 整列会跟着消息条数一直长高、永远不出滚动条。这里用视口兜底封顶。
        // 高度按视口百分比算（44vh，最多 420px）：比用 100vh 减常数更可控，
        // 小窗口不会算出负数，大屏也不会一列就顶满整屏。
        maxHeight: 'min(44vh, 420px)',
        minHeight: '120px',
        overflowY: 'auto',
        // 显式声明滚动条宽度/颜色：默认细滚动条在部分主题下几乎看不见。
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--dsw-alias-border-l1) transparent',
        padding: '8px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      },
      digestItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      digestMsgUser: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '7px 9px',
        borderRadius: 8,
        borderLeft: '2px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      digestMsgAssistant: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '7px 9px',
        borderRadius: 8,
        borderLeft: `2px solid ${RUNNING_COLOR}`,
        background: 'var(--dsw-alias-bg-base)',
      },
      moreBtn: {
        alignSelf: 'stretch',
        marginBottom: 6,
        padding: '4px 8px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        cursor: 'pointer',
      },
      sendBox: {
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        padding: '7px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        flex: '0 0 auto',
      },
      sendInput: {
        width: '100%',
        boxSizing: 'border-box',
        resize: 'none',
        padding: '5px 7px',
        fontSize: 12,
        lineHeight: 1.45,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        outline: 'none',
      },
      sendRow: { display: 'flex', alignItems: 'center', gap: 6 },
      sendBtn: {
        padding: '3px 10px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid transparent',
        borderRadius: 6,
        cursor: 'pointer',
      },
      sendStop: {
        padding: '3px 10px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        cursor: 'pointer',
      },
      sendNote: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto' },
      digestRole: {
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
      },
      digestText: {
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      pinBtn: {
        flex: '0 0 auto',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: 1,
        cursor: 'pointer',
        padding: '0 2px',
        borderRadius: 4,
      },
      pinBtnActive: {
        color: 'var(--dsw-alias-brand-primary)',
      },
      boardEmpty: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        padding: 20,
        textAlign: 'center',
      },
    }

    /* ------------------------------------------------------------------ *
     * 面板
     * ------------------------------------------------------------------ */

    function StatusDot(props) {
      const color = props.running ? RUNNING_COLOR : props.finished ? FINISHED_COLOR : 'var(--dsw-alias-label-secondary)'
      const style = { ...S.dot, background: color, marginTop: 5 }
      if (props.running) {
        style.boxShadow = `0 0 0 3px rgba(34,160,107,0.16)`
      }
      return h('span', { style })
    }

    /**
     * 列表卡片上的一行「最后说了什么」。
     * 只对运行中 / 刚完成的卡片挂载，且只拉一次（不轮询）——目的是不用钉住也能知道结果，
     * 所以刻意用很小的 limit，别让列表本身变成 15 个并发重放。
     */
    function LastLine(props) {
      const entry = props.entry
      // 第五个参数 false：卡片末行只拉一次，不参与慢轮询。
      // 否则 15 张卡片会各自每 8 秒打一次 /digest，列表页瞬间变成负载源。
      const digest = useDigest(entry.id, false, 3, 0, false)
      if (digest.error !== '' || digest.items.length === 0) return null
      let text = ''
      for (let index = digest.items.length - 1; index >= 0; index -= 1) {
        const item = digest.items[index]
        if (item && item.kind === 'assistant' && item.text) {
          text = String(item.text)
          break
        }
      }
      if (text === '') {
        // 没有助手正文时退到最后一条（现在只可能是"我"的消息），
        // 工具行在 Host 侧已经被丢掉，这里不会出现。
        const last = digest.items[digest.items.length - 1]
        if (last && last.text) text = `[我] ${last.text}`
      }
      if (text === '') return null
      return h('div', { style: S.cardLast }, clip(text.replace(/\s+/g, ' ').trim(), 160))
    }

    function SessionCard(props) {
      const entry = props.entry
      const meta = []
      if (entry.running) meta.push('运行中')
      else if (entry.finishedAt) meta.push(`完成于 ${relativeTime(entry.finishedAt)}`)
      else if (entry.updatedAt) meta.push(relativeTime(entry.updatedAt))
      if (entry.turns) meta.push(`${entry.turns} 轮`)
      if (entry.subagents) meta.push(`${entry.subagents} 子代理`)
      if (entry.tokens) meta.push(formatTokens(entry.tokens))
      if (entry.model) meta.push(entry.model)

      const cardStyle = { ...S.card }
      if (entry.running) Object.assign(cardStyle, S.cardRunning)
      else if (entry.finishedAt) Object.assign(cardStyle, S.cardFinished)

      return h(
        'div',
        {
          style: cardStyle,
          onClick: () => props.onOpen(entry.id),
          onMouseEnter: (event) => {
            event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-1)'
          },
          title: entry.cwd || entry.title,
        },
        h(StatusDot, { running: entry.running, finished: Boolean(entry.finishedAt) }),
        h(
          'div',
          { style: S.cardBody },
          h(
            'div',
            { style: S.cardTitleRow },
            h('span', { style: S.cardTitle }, entry.title),
            entry.running
              ? h('span', { style: { ...S.badge, color: RUNNING_COLOR } }, '运行中')
              : null,
            !entry.running && entry.finishedAt
              ? h('span', { style: { ...S.badge, color: FINISHED_COLOR } }, '待查看')
              : null,
            entry.parentId || entry.origin === 'subagent'
              ? h('span', { style: { ...S.badge, color: 'var(--dsw-alias-label-secondary)' } }, '子代理')
              : null,
            h(
              'button',
              {
                type: 'button',
                style: { ...S.pinBtn, ...(props.pinned ? S.pinBtnActive : {}) },
                title: props.pinned ? '取消钉住' : '钉住，并排看它的对话',
                onClick: (event) => {
                  event.stopPropagation()
                  props.onPin(entry.id)
                },
              },
              props.pinned ? '⊟' : '⊞',
            ),
          ),
          meta.length > 0 ? h('div', { style: S.metaRow }, meta.map((text, index) => h('span', { key: index }, text))) : null,
          entry.running || entry.finishedAt ? h(LastLine, { entry }) : null,
        ),
      )
    }

    /** 精简模式下最多列多少个"闲着"的会话（运行中/刚完成的永远全列）。 */
    const IDLE_LIMIT = 15

    /* ------------------------------------------------------------------ *
     * 并排对话（Phase 2）
     *
     * 客户端事件窗（sessions.retain → eventSource）只对"正被会话视图打开"的会话
     * 填充，实测对历史会话永远是 entries=0，所以对话正文只能走 Host 半边的
     * /digest 路由（sessionQuery.readSession 读真实事件日志再折叠）。
     * ------------------------------------------------------------------ */

    /**
     * 默认只拉 20 条：并排列的作用是"扫一眼这段在聊什么"，不是复现整个会话。
     * 20 条大约一屏，一打开就是最近的对话，不会一上来就是一堵墙。
     * 要往前翻用「载入更早」，每次再加 20 条。
     */
    const DIGEST_LIMIT = 20
    /** 运行中会话的轮询间隔：1.2 秒，接近"看着它写"的体感。 */
    const DIGEST_REFRESH_MS = 1200
    /**
     * 已停下会话的慢轮询：8 秒一次。
     * 为什么停下来了还要轮？
     *   "跑完了"这件事必须能在原地看到结果，而运行状态翻转的那一次请求万一拿到
     *   缓冲里的旧内容（或者快照翻转本身晚到一帧），面板就会永远停在"没有回复、
     *   也没有显示完成"，只有重开面板才恢复。慢轮询是兜底，成本很低
     *   （历史会话 observeSession 约 84ms，最多 3 列，8 秒一次）。
     */
    const DIGEST_IDLE_REFRESH_MS = 8000
    const MAX_PINNED = 3

    async function fetchDigest(sessionId, limit, live, fresh) {
      const liveFlag = live === true ? '&live=1' : ''
      const freshFlag = fresh === true ? '&fresh=1' : ''
      const response = await fetch(
        `/plugins/dsh-multi-session/digest?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${liveFlag}${freshFlag}`,
        { cache: 'no-store' },
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (!body || body.ok !== true) throw new Error('digest unavailable')
      return body
    }

    /**
     * 拉一个会话的对话摘要。
     * 运行中的会话按 DIGEST_REFRESH_MS（1.2 秒）轮询；
     * 停下之后不再停止轮询，而是降到 DIGEST_IDLE_REFRESH_MS（8 秒）继续守着 ——
     * 这样"跑完了"的最后一句话一定会在原地补上，不用重开面板。
     * limit 变化（用户点「载入更早」）会重新拉一次。
     */
    function useDigest(sessionId, live, limit, nonce, poll) {
      const take = Number(limit) > 0 ? Number(limit) : DIGEST_LIMIT
      const bump = Number(nonce) || 0
      /** 是否开启"停下之后继续慢轮询"。列表卡片的末行摘要传 false，只拉一次。 */
      const keepPolling = poll !== false
      const [state, setState] = React.useState({ items: [], turns: 0, endReason: null, error: '', loading: true })
      /**
       * 上一次是不是"运行中"。用来识别"刚跑完"这一帧：
       * 这时候必须绕开缓存拿最新的，否则会显示成"没有回复也没有完成"。
       */
      const wasLiveRef = React.useRef(false)
      React.useEffect(() => {
        let cancelled = false
        // 从运行中变成停下：这一发强制绕过 Host 缓存。
        const justStopped = wasLiveRef.current && !live
        wasLiveRef.current = live
        const load = async (fresh) => {
          try {
            const body = await fetchDigest(sessionId, take, live, fresh === true)
            if (cancelled) return
            setState({
              items: Array.isArray(body.items) ? body.items : [],
              turns: Number(body.turns) || 0,
              endReason: body.endReason || null,
              error: '',
              loading: false,
            })
          } catch (cause) {
            if (cancelled) return
            setState((previous) => ({
              ...previous,
              error: String(cause && cause.message ? cause.message : cause),
              loading: false,
            }))
          }
        }
        setState((previous) => ({ ...previous, loading: true }))
        load(justStopped)
        if (!live && !keepPolling) return () => { cancelled = true }
        const period = live ? DIGEST_REFRESH_MS : DIGEST_IDLE_REFRESH_MS
        const handle = setInterval(() => load(false), period)
        return () => {
          cancelled = true
          clearInterval(handle)
        }
      }, [sessionId, live, take, bump, keepPolling])
      return state
    }

    function clip(text, max) {
      const value = typeof text === 'string' ? text : ''
      return value.length > max ? `${value.slice(0, max)}…` : value
    }

    /**
     * 渲染一条对话。正文按原样保留换行、只做长度上限，不压成摘要。
     * 并排视图只保留"我 ↔ AI 的对话正文"，
     * 工具调用/思考过程在 Host 侧折叠阶段就丢掉了，这里再兜一层：
     * 认不出的类型直接跳过，不画任何噪音行。
     */
    function renderDigestItem(item, index) {
      const kind = item && item.kind
      if (kind !== 'user' && kind !== 'assistant') return null
      const isUser = kind === 'user'
      const roleText = isUser ? '我' : '助手'
      const color = isUser ? 'var(--dsw-alias-brand-primary)' : RUNNING_COLOR
      return h(
        'div',
        { key: index, style: isUser ? S.digestMsgUser : S.digestMsgAssistant },
        h('span', { style: { ...S.digestRole, color } }, roleText),
        h('div', { style: S.digestText }, clip(item.text, 6000)),
      )
    }

    /**
     * 并排列底部的输入框：不用切到那个会话就能回一句，或把它打断。
     * 默认 queue（排进收件箱，不打断正在跑的回合）；按住 Shift 发送 = steer（立刻插话）。
     */
    function SendBox(props) {
      const entry = props.entry
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      const post = async (payload) => {
        const response = await fetch('/plugins/dsh-multi-session/prompt', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body || body.ok !== true) {
          throw new Error((body && body.error) || `HTTP ${response.status}`)
        }
        return body
      }

      const send = async (steer) => {
        const value = text.trim()
        if (value === '' || busy) return
        setBusy(true)
        setNote('')
        try {
          await post({ sessionId: entry.id, text: value, mode: steer ? 'steer' : 'queue' })
          setText('')
          setNote(steer ? '已插话' : '已发送')
          if (typeof props.onSent === 'function') props.onSent()
        } catch (cause) {
          setNote(`发送失败：${cause && cause.message ? cause.message : cause}`)
        } finally {
          setBusy(false)
        }
      }

      const stop = async () => {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          await post({ sessionId: entry.id, action: 'cancel' })
          setNote('已请求停止')
        } catch (cause) {
          setNote(`停止失败：${cause && cause.message ? cause.message : cause}`)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: S.sendBox },
        h('textarea', {
          style: S.sendInput,
          rows: 2,
          value: text,
          placeholder: entry.running ? '给它排一条消息（Shift+Enter 立即插话）' : '给这个会话发一条消息',
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            send(Boolean(event.shiftKey))
          },
        }),
        h(
          'div',
          { style: S.sendRow },
          h(
            'button',
            {
              type: 'button',
              style: { ...S.sendBtn, opacity: busy || text.trim() === '' ? 0.5 : 1 },
              disabled: busy || text.trim() === '',
              onClick: () => send(false),
            },
            busy ? '…' : '发送',
          ),
          entry.running
            ? h(
                'button',
                {
                  type: 'button',
                  style: { ...S.sendStop, opacity: busy ? 0.5 : 1 },
                  disabled: busy,
                  title: '打断这个会话当前正在跑的回合',
                  onClick: stop,
                },
                '停止',
              )
            : null,
          note !== '' ? h('span', { style: S.sendNote }, note) : null,
        ),
      )
    }

    function PinnedColumn(props) {
      const entry = props.entry
      const [limit, setLimit] = React.useState(DIGEST_LIMIT)
      const [nonce, setNonce] = React.useState(0)
      const digest = useDigest(entry.id, Boolean(entry.running), limit, nonce)
      const scrollRef = React.useRef(null)
      const limitRef = React.useRef(limit)
      /** 首次加载直接贴底：看别的会话就是想看"它现在说到哪了"，从最新一条往回看。 */
      const firstLoadRef = React.useRef(true)
      /** 用户是否停在底部附近（决定新消息来了要不要跟着滚）。默认算在底部。 */
      const stickRef = React.useRef(true)

      /**
       * 滚动策略：
       * - 首次加载 → 直接贴底（看的是"现在说到哪了"）；
       * - 用户停在底部时跟着新消息滚，往上翻历史时不打断；
       * - 点「载入更早」导致的条数变化不触发滚动，否则等于白点。
       */
      React.useEffect(() => {
        const node = scrollRef.current
        if (!node) return
        if (digest.items.length === 0) return
        if (limitRef.current !== limit) {
          // 用户点了「载入更早」：保持视线不动，把新增的更早内容留在上面。
          limitRef.current = limit
          return
        }
        if (firstLoadRef.current) {
          firstLoadRef.current = false
          node.scrollTop = node.scrollHeight
          return
        }
        if (stickRef.current) node.scrollTop = node.scrollHeight
      }, [digest.items, limit])

      const hasMore = digest.items.length >= limit
      const meta = entry.running
        ? '运行中'
        : digest.turns > 0
          ? `${digest.turns} 轮`
          : entry.updatedAt
            ? relativeTime(entry.updatedAt)
            : ''

      let content
      if (digest.loading && digest.items.length === 0) {
        content = h('div', { style: S.boardEmpty }, '正在读取对话…')
      } else if (digest.error !== '') {
        content = h('div', { style: S.boardEmpty }, `读取失败：${digest.error}`)
      } else if (digest.items.length === 0) {
        content = h('div', { style: S.boardEmpty }, '这个会话还没有可显示的对话。')
      } else {
        content = digest.items.map((item, index) => renderDigestItem(item, index))
      }

      const head = h(
        'div',
        { style: S.boardColHead },
        h(StatusDot, { running: entry.running, finished: Boolean(entry.finishedAt) }),
        h(
          'span',
          {
            style: S.boardColTitle,
            title: `${entry.title}\n点击打开这个会话`,
            onClick: () => props.onOpen(entry.id),
          },
          entry.title,
        ),
        h('span', { style: S.boardColMeta }, meta),
        h(
          'button',
          {
            type: 'button',
            style: S.pinBtn,
            title: '取消钉住',
            onClick: () => props.onUnpin(entry.id),
          },
          '×',
        ),
      )

      const moreBar =
        hasMore && digest.error === ''
          ? h(
              'button',
              {
                type: 'button',
                style: S.moreBtn,
                onClick: () => setLimit((value) => value + DIGEST_LIMIT),
              },
              `载入更早（当前 ${digest.items.length} 条）`,
            )
          : null

      return h(
        'div',
        { style: S.boardCol },
        head,
        h(
          'div',
          {
            style: S.boardScroll,
            ref: scrollRef,
            // 记住用户是否停在底部附近：只有本来就在底部，新消息才跟着滚。
            onScroll: (event) => {
              const node = event.currentTarget
              stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            },
          },
          moreBar,
          content,
        ),
        h(SendBox, { entry, onSent: () => setNonce((value) => value + 1) }),
      )
    }

    function MultiSessionPanel(props) {
      const sessions = props.useSessions(identity)
      const workspaces = props.useWorkspaces(identity)
      const [showArchived, setShowArchived] = React.useState(false)
      const [showSubagents, setShowSubagents] = React.useState(false)
      const [showAll, setShowAll] = React.useState(false)
      /**
       * 钉住的会话必须活过刷新：否则一退出再进来，三个并排列全没了，
       * 等于每次都要重新挑一遍。写进 localStorage，键值都落盘。
       */
      const [pinned, setPinned] = React.useState(() => loadPinned())
      const [tick, setTick] = React.useState(0)

      const workspaceIndex = React.useMemo(() => readWorkspaces(workspaces), [workspaces])
      const entries = React.useMemo(
        () => readEntries(sessions, workspaceIndex),
        // tick 必须在依赖里：点「打开」时先删掉 finishedAt 再 setTick，
        // 如果这里只依赖 sessions，entries 不会重算，卡片上的"待查看"就永远不消失。
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sessions, workspaceIndex, tick],
      )

      /** 完成检测必须在渲染前跑，发现新完成就重渲染一次（拿到 finishedAt）。 */
      React.useEffect(() => {
        if (detectFinished(entries)) setTick((value) => value + 1)
      }, [entries])

      /** 让「3 分钟前」这类相对时间自己走。 */
      React.useEffect(() => {
        const handle = setInterval(() => setTick((value) => value + 1), 30000)
        return () => clearInterval(handle)
      }, [])

      const visible = React.useMemo(() => {
        const filtered = entries.filter((entry) => {
          if (!showArchived && entry.archived) return false
          if (!showSubagents && (entry.parentId || entry.origin === 'subagent')) return false
          if (entry.blank) return false
          return true
        })
        if (showAll) return filtered
        // 精简：运行中和刚完成的必须留，其余按最近活跃取前 IDLE_LIMIT 个。
        const ranked = filtered
          .slice()
          .sort((left, right) => rankOf(left) - rankOf(right) || right.updatedAt - left.updatedAt)
        const kept = []
        let idle = 0
        for (const entry of ranked) {
          if (entry.running || entry.finishedAt) {
            kept.push(entry)
            continue
          }
          if (idle < IDLE_LIMIT) {
            kept.push(entry)
            idle++
          }
        }
        return kept
      }, [entries, showArchived, showSubagents, showAll])

      const runningCount = visible.filter((entry) => entry.running).length
      const finishedCount = visible.filter((entry) => !entry.running && entry.finishedAt).length

      const grouped = React.useMemo(() => {
        const buckets = new Map()
        for (const entry of visible) {
          const key = entry.groupId || entry.cwd || '__other__'
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              key,
              title: entry.groupTitle || basename(entry.cwd) || '其他会话',
              path: entry.groupPath || entry.cwd || '',
              entries: [],
            }
            buckets.set(key, bucket)
          }
          bucket.entries.push(entry)
        }
        const rank = rankOf
        const groups = Array.from(buckets.values())
        for (const group of groups) {
          group.entries.sort((left, right) => {
            const delta = rank(left) - rank(right)
            if (delta !== 0) return delta
            if (left.finishedAt !== right.finishedAt) return right.finishedAt - left.finishedAt
            return right.updatedAt - left.updatedAt
          })
        }
        groups.sort((left, right) => {
          const leftTop = rank(left.entries[0])
          const rightTop = rank(right.entries[0])
          if (leftTop !== rightTop) return leftTop - rightTop
          return right.entries[0].updatedAt - left.entries[0].updatedAt
        })
        return groups
      }, [visible])

      /** 打开某个会话：清掉待查看标记，并且把"我看到了这个版本"刷进基线。 */
      const handleOpen = React.useCallback(
        (sessionId) => {
          finishedAt.delete(sessionId)
          saveFinished()
          // 关键：只删 finishedAt 不够。冷启动补标（catchUpFinished）比的是
          // "上次记住的 updatedAt vs 现在的 updatedAt"，如果基线还停在这之前，
          // 页面一刷新（primed 归零 → 走冷启动分支）就会把它重新标成待查看，
          // 看起来就是"点了也白点"。
          // 基线写 Date.now() 而不是现在这个 updatedAt：语义是"此刻之前的一切我都看过了"。
          // 打开会话本身也会把 updatedAt 往前推一点，用旧值当基线会被自己顶掉。
          const entry = entries.find((item) => item.id === sessionId)
          const seenAt = Math.max(entry && entry.updatedAt > 0 ? entry.updatedAt : 0, Date.now())
          lastSeen.set(sessionId, seenAt)
          saveSeen(true)
          openSession(sessionId)
          setTick((value) => value + 1)
        },
        [entries],
      )

      /** 全部已读：待查看清空，所有会话的基线一起推进到当前版本。 */
      const clearFinished = React.useCallback(() => {
        finishedAt.clear()
        saveFinished()
        for (const entry of entries) {
          if (!entry.blank && entry.updatedAt > 0) lastSeen.set(entry.id, entry.updatedAt)
        }
        saveSeen(true)
        setTick((value) => value + 1)
      }, [entries])

      /** 钉住/取消钉住；超过 MAX_PINNED 就挤掉最早钉的那个。每次都落盘。 */
      const togglePin = React.useCallback((sessionId) => {
        setPinned((current) => {
          let next
          if (current.indexOf(sessionId) >= 0) next = current.filter((id) => id !== sessionId)
          else if (current.length >= MAX_PINNED) next = current.slice(1).concat(sessionId)
          else next = current.concat(sessionId)
          savePinned(next)
          return next
        })
      }, [])

      const unpin = React.useCallback((sessionId) => {
        setPinned((current) => {
          const next = current.filter((id) => id !== sessionId)
          savePinned(next)
          return next
        })
      }, [])

      const pinnedEntries = React.useMemo(
        () =>
          pinned
            .map((sessionId) => entries.find((entry) => entry.id === sessionId))
            .filter((entry) => Boolean(entry)),
        [pinned, entries],
      )

      const splitMode = pinnedEntries.length > 0

      const totalVisible = visible.length

      const listContent =
        grouped.length === 0
          ? sessions && sessions.phase !== 'ready'
            ? h('div', { style: S.empty }, '正在加载会话列表…')
            : h(
                'div',
                { style: S.empty },
                '还没有可显示的会话。',
                h('br'),
                '开一个新会话跑起来，这里就会实时出现。',
              )
          : grouped.map((group) =>
              h(
                'div',
                { key: group.key, style: S.group },
                h(
                  'div',
                  { style: S.groupHeader },
                  h('span', { style: S.groupName }, group.title),
                  group.path && group.path !== group.title
                    ? h('span', { style: S.groupPath }, group.path)
                    : null,
                  h('span', { style: { opacity: 0.6 } }, `${group.entries.length}`),
                ),
                group.entries.map((entry) =>
                  h(SessionCard, {
                    key: entry.id,
                    entry,
                    onOpen: handleOpen,
                    onPin: togglePin,
                    pinned: pinned.indexOf(entry.id) >= 0,
                  }),
                ),
              ),
            )

      const listTail =
        !showAll && entries.length > visible.length
          ? h(
              'div',
              { style: { ...S.empty, padding: '10px 20px' } },
              `另有 ${entries.length - visible.length} 个较久没动的会话，勾选「全部」展开。`,
            )
          : null

      const listPane = h(
        'div',
        { style: splitMode ? S.listPane : S.listPaneWide },
        listContent,
        listTail,
      )

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h('span', { style: S.headerTitle }, '多会话'),
          runningCount > 0
            ? h(
                'span',
                { style: S.counter },
                h('span', { style: { ...S.dot, background: RUNNING_COLOR } }),
                `${runningCount} 运行中`,
              )
            : null,
          finishedCount > 0
            ? h(
                'span',
                { style: S.counter },
                h('span', { style: { ...S.dot, background: FINISHED_COLOR } }),
                `${finishedCount} 待查看`,
              )
            : null,
          h('span', { style: S.counter }, `${totalVisible} 个会话`),
          h('span', { style: S.spacer }),
          h(
            'label',
            { style: { ...S.counter, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showAll,
              onChange: (event) => setShowAll(event.target.checked),
              style: { margin: 0 },
            }),
            '全部',
          ),
          h(
            'label',
            { style: { ...S.counter, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showSubagents,
              onChange: (event) => setShowSubagents(event.target.checked),
              style: { margin: 0 },
            }),
            '子代理',
          ),
          h(
            'label',
            { style: { ...S.counter, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showArchived,
              onChange: (event) => setShowArchived(event.target.checked),
              style: { margin: 0 },
            }),
            '归档',
          ),
          finishedCount > 0
            ? h(
                'button',
                { style: S.button, onClick: clearFinished, type: 'button' },
                '清除标记',
              )
            : null,
        ),
        splitMode
          ? h(
              'div',
              { style: S.split },
              listPane,
              h(
                'div',
                { style: S.board },
                pinnedEntries.map((entry) =>
                  h(PinnedColumn, {
                    key: entry.id,
                    entry,
                    onOpen: handleOpen,
                    onUnpin: unpin,
                  }),
                ),
              ),
            )
          : h('div', { style: S.body }, listContent, listTail),
      )
    }

    /* ------------------------------------------------------------------ *
     * 开发期诊断层
     *
     * conversation.view 只有用户切到那个页签才会挂载，所以「面板拿到数据了吗」
     * 没法靠面板自己回报。这里注册一个常驻 overlay（渲染 null），用同一套解析
     * 逻辑算一遍统计并回传 Host 落盘，页面一刷新就能离线核对。
     * ------------------------------------------------------------------ */

    /** 每个 phase 只报一次，最多 4 次（pending → ready 这类过渡要抓全）。 */
    const diagPosted = new Set()

    function DiagOverlay(props) {
      const sessions = typeof props.useSessions === 'function' ? props.useSessions(identity) : undefined
      const workspaces =
        typeof props.useWorkspaces === 'function' ? props.useWorkspaces(identity) : undefined
      // hook 必须无条件、按固定顺序调用，不能塞进 IIFE。
      const statusSnap =
        typeof props.useSessionStatus === 'function' ? props.useSessionStatus(identity) : undefined
      const phase = (sessions && sessions.phase) || 'none'

      React.useEffect(() => {
        if (diagPosted.has(phase) || diagPosted.size >= 4) return
        diagPosted.add(phase)
        let error = null
        let payload
        try {
          const workspaceIndex = readWorkspaces(workspaces)
          const entries = readEntries(sessions, workspaceIndex)
          const visible = entries.filter((entry) => !entry.blank)
          payload = {
            phase: 'panel',
            build: BUILD,
            sessionsPhase: phase,
            at: new Date().toISOString(),
            hasSessions: Boolean(sessions),
            idsLength: sessions && Array.isArray(sessions.ids) ? sessions.ids.length : -1,
            total: entries.length,
            running: visible.filter((entry) => entry.running).length,
            withCwd: visible.filter((entry) => entry.cwd).length,
            withUpdatedAt: visible.filter((entry) => entry.updatedAt > 0).length,
            archived: visible.filter((entry) => entry.archived).length,
            withParent: visible.filter((entry) => entry.parentId).length,
            workspaces: workspaceIndex.groups.length,
            groups: workspaceIndex.groups.map((group) => ({
              title: group.title,
              path: group.path,
              count: group.sessionIds.length,
            })),
            sample: visible.slice(0, 5).map((entry) => ({
              id: entry.id,
              title: entry.title,
              running: entry.running,
              updatedAt: entry.updatedAt,
              cwd: entry.cwd,
              group: entry.groupTitle,
              turns: entry.turns,
              tokens: entry.tokens,
              model: entry.model,
            })),
            // 一次性探明 modelSelection 的真实形状（之前 model 一直为空）。
            modelRaw: (() => {
              try {
                const table =
                  sessions && sessions.projectionsBySession && typeof sessions.projectionsBySession === 'object'
                    ? sessions.projectionsBySession
                    : {}
                for (const key of Object.keys(table).slice(0, 12)) {
                  const values = table[key] && table[key].values
                  const selection = values && values.modelSelection
                  if (selection !== undefined && selection !== null) {
                    return JSON.stringify(selection).slice(0, 160)
                  }
                }
                return 'none'
              } catch (cause) {
                return `threw: ${String(cause)}`
              }
            })(),
            // 一次性探明"当前会话"能不能被识别（决定浮标要不要排除当前会话）。
            locRaw: (() => {
              try {
                return JSON.stringify({
                  path: String(location.pathname || '').slice(0, 120),
                  hash: String(location.hash || '').slice(0, 120),
                  search: String(location.search || '').slice(0, 60),
                })
              } catch (cause) {
                return `threw: ${String(cause)}`
              }
            })(),
            // 列表级 UI 状态里是否带"当前选中"标记。
            listMetaRaw: (() => {
              try {
                const table =
                  sessions && sessions.projectionsBySession && typeof sessions.projectionsBySession === 'object'
                    ? sessions.projectionsBySession
                    : {}
                for (const key of Object.keys(table).slice(0, 12)) {
                  const values = table[key] && table[key].values
                  const meta = values && values.sessionListMetadata
                  if (meta !== undefined && meta !== null) {
                    return JSON.stringify(meta).slice(0, 240)
                  }
                }
                return 'none'
              } catch (cause) {
                return `threw: ${String(cause)}`
              }
            })(),
            // useSessionStatus 的真实返回形状。
            statusRaw: (() => {
              try {
                return JSON.stringify(statusSnap).slice(0, 240)
              } catch (cause) {
                return `threw: ${String(cause)}`
              }
            })(),
            activeSessionId,
          }
        } catch (cause) {
          error = String(cause)
        }
        post({ phase: 'panel', build: BUILD, at: new Date().toISOString(), error, payload })

        // 一次性探明 /prompt 的 content 形状：拿一个不存在的 sessionId 试发。
        // 期望「会话找不到」类错误——说明 content:[{type:'text',text}] 被接受了；
        // 如果报的是 content/校验类错误，就说明形状猜错了。
        if (!promptProbed) {
          promptProbed = true
          void (async () => {
            try {
              const response = await fetch('/plugins/dsh-multi-session/prompt', {
                method: 'POST',
                cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  sessionId: 'session-00000000-0000-0000-0000-000000000000',
                  text: 'shape-probe',
                }),
              })
              const body = await response.json().catch(() => null)
              post({
                phase: 'prompt-shape',
                build: BUILD,
                at: new Date().toISOString(),
                status: response.status,
                ok: Boolean(body && body.ok),
                error: String((body && body.error) || ''),
              })
            } catch (cause) {
              post({ phase: 'prompt-shape', build: BUILD, at: new Date().toISOString(), error: String(cause) })
            }
          })()
        }

        // 紧跟 panel 探针做一次 /digest 自检（surface 模式 + 缓存命中），
        // 挂在这里而不是独立 effect，是因为实测独立 effect 有时不触发。
        if (digestProbed) return
        digestProbed = true
        const digestTarget =
          activeSessionId || (Array.isArray(payload.sample) && payload.sample[0] ? String(payload.sample[0].id) : '')
        if (digestTarget === '') return
        void (async () => {
          const lines = []
          // 面板真实路径：observe + DIGEST_LIMIT 条，测耗时与载荷大小。
          const realUrl = `sessionId=${encodeURIComponent(digestTarget)}&limit=${DIGEST_LIMIT}&fresh=1`
          const probes = [
            { label: 'panel-live', url: realUrl, bytes: true },
            { label: 'panel-live-cached', url: realUrl, bytes: true },
          ]
          for (const probe of probes) {
            try {
              const response = await fetch(`/plugins/dsh-multi-session/digest?${probe.url}`, { cache: 'no-store' })
              const raw = await response.text()
              const body = JSON.parse(raw)
              if (!body || body.ok !== true) {
                lines.push(`${probe.label} http=${response.status} body=${String(raw).slice(0, 120)}`)
                continue
              }
              const items = Array.isArray(body.items) ? body.items : []
              lines.push(
                `${probe.label} ms=${body.ms} cached=${body.cached} source=${body.source} events=${body.eventCount} turns=${body.turns} items=${items.length} bytes=${raw.length}`,
              )
              if (probe.bytes === true) {
                for (const item of items.slice(-2)) {
                  lines.push(`  [${item.kind}] ${String(item.text).slice(0, 70).replace(/\n/g, ' ')}`)
                }
              }
            } catch (cause) {
              lines.push(`${probe.label} threw ${String(cause)}`)
            }
          }
          post({ phase: 'digest', build: BUILD, at: new Date().toISOString(), target: digestTarget, lines })
        })()
      }, [phase])

      // 一次性探针：Phase 2「并排对话流」的可行性前提——
      // 客户端能否 retain 别的会话并读到它的消息事件流。
      React.useEffect(() => {
        if (retainProbed) return
        retainProbed = true
        const sessionsService = getService('sessions')
        if (!sessionsService || typeof sessionsService.retain !== 'function') {
          post({ phase: 'retain', build: BUILD, at: new Date().toISOString(), error: 'no sessions service' })
          return
        }
        const describe = (label, value) => {
          try {
            if (value === null || value === undefined) return `${label}: ${String(value)}`
            if (typeof value !== 'object') return `${label}: ${typeof value} = ${String(value).slice(0, 80)}`
            const keys = Object.keys(value)
            return `${label}: object{${keys.slice(0, 12).join(',')}}`
          } catch (cause) {
            return `${label}: threw ${String(cause)}`
          }
        }
        let reference
        const report = {}
        const lines = []
        const run = async () => {
          try {
            // 选一个"不是当前会话、且有内容"的历史会话，检验事件窗是否懒加载。
            let targetId = activeSessionId
            try {
              const table =
                sessions && sessions.projectionsBySession && typeof sessions.projectionsBySession === 'object'
                  ? sessions.projectionsBySession
                  : {}
              for (const key of Object.keys(table)) {
                if (key === activeSessionId) continue
                const values = table[key] && table[key].values
                const outline = values && Array.isArray(values.turnOutline) ? values.turnOutline : []
                if (outline.length > 0) {
                  targetId = key
                  break
                }
              }
            } catch (cause) {
              lines.push(`pickTarget threw ${String(cause)}`)
            }
            lines.push(`target=${targetId.slice(0, 44)} active=${targetId === activeSessionId}`)
            reference = sessionsService.retain({ sessionId: targetId }, {})
            lines.push(describe('reference', reference))
            // 关键：retain 是异步就绪的，readiness.promise 解析前 eventSource 是空的。
            const readiness = reference && reference.readiness
            if (readiness && readiness.promise) {
              const settled = await Promise.race([
                readiness.promise.then(() => 'resolved', () => 'rejected'),
                new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
              ])
              lines.push(`readiness=${settled}`)
            }
            const binding =
              (reference && reference.record && reference.record.binding) ||
              (typeof sessionsService.binding === 'function' ? sessionsService.binding(targetId) : null)
            lines.push(describe('binding', binding))
            const source = binding && binding.eventSource
            lines.push(describe('eventSource', source))
            // 实测 eventSource 是 {listeners, window, snapshot}，不是带 get() 的对象。
            const window_ =
              source && source.snapshot && typeof source.snapshot === 'object'
                ? source.snapshot
                : source && source.window && typeof source.window === 'object'
                  ? source.window
                  : null
            lines.push(describe('window(from snapshot)', window_))
            // 把 window 自身 + 原型的成员全列出来，找分页/加载入口。
            try {
              const own = window_ ? Object.keys(window_) : []
              const proto = window_ ? Object.getOwnPropertyNames(Object.getPrototypeOf(window_)) : []
              lines.push(`window.own=[${own.join(',')}] proto=[${proto.join(',')}]`)
              for (const key of own.concat(proto)) {
                if (key === 'constructor') continue
                const type = typeof window_[key]
                const extra = type === 'function' ? ` arity=${window_[key].length}` : ''
                lines.push(`  window.${key}: ${type}${extra}`)
              }
            } catch (cause) {
              lines.push(`window inspect threw ${String(cause)}`)
            }
            // eventSource 的订阅接口长什么样。
            try {
              const listeners = source && source.listeners
              const own = listeners ? Object.keys(listeners) : []
              const proto = listeners ? Object.getOwnPropertyNames(Object.getPrototypeOf(listeners)) : []
              lines.push(`listeners own=[${own.join(',')}] proto=[${proto.slice(0, 10).join(',')}]`)
            } catch (cause) {
              lines.push(`listeners inspect threw ${String(cause)}`)
            }
            const entries = window_ && Array.isArray(window_.entries) ? window_.entries : []
            lines.push(`entries=${entries.length} change=${window_ ? window_.change : 'n/a'}`)
            const sample = entries.slice(-3).map((entry) => {
              try {
                const event = entry && entry.event ? entry.event : entry
                const kind =
                  event && typeof event === 'object'
                    ? event.type || event.kind || event.role || '?'
                    : typeof event
                return `${String(kind).slice(0, 24)} :: ${JSON.stringify(event).slice(0, 180)}`
              } catch (cause) {
                return `threw ${String(cause)}`
              }
            })
            lines.push(...sample)
            const sessionFace = binding && binding.session
            const snapshot =
              sessionFace && typeof sessionFace.get === 'function'
                ? sessionFace.get()
                : sessionFace && sessionFace.snapshot && typeof sessionFace.snapshot === 'object'
                  ? sessionFace.snapshot
                  : null
            lines.push(describe('sessionSnapshot', snapshot))
            if (snapshot) {
              lines.push(`snapshot.running=${snapshot.running} pending=${snapshot.pendingSubmissions}`)
            }
            // 端到端验证 Host 侧 /digest：默认走 surface（最快内容路径），
            // 再打一次同样的请求确认 Host 缓存命中（第二次应该几毫秒返回）。
            for (const mode of ['surface', 'surface']) {
              try {
                const response = await fetch(
                  `/plugins/dsh-multi-session/digest?mode=${mode}&sessionId=${encodeURIComponent(targetId)}&limit=8`,
                  { cache: 'no-store' },
                )
                const body = await response.json()
                if (!body || body.ok !== true) {
                  lines.push(`digest[${mode}] http=${response.status} body=${JSON.stringify(body).slice(0, 120)}`)
                  continue
                }
                lines.push(
                  `digest[${mode}] ms=${body.ms} cached=${body.cached} age=${body.age} events=${body.eventCount} turns=${body.turns} items=${Array.isArray(body.items) ? body.items.length : 'n/a'}`,
                )
                if (Array.isArray(body.items)) {
                  for (const item of body.items.slice(-3)) {
                    lines.push(`  [${item.kind}] ${String(item.text).slice(0, 90).replace(/\n/g, ' ')}`)
                  }
                }
              } catch (cause) {
                lines.push(`digest[${mode}] threw ${String(cause)}`)
              }
            }
          } catch (cause) {
            report.error = String(cause)
          } finally {
            try {
              // 实测释放方法是 releaseReference（没有 release），必须配对调用，否则会话被永久持有。
              if (reference && typeof reference.releaseReference === 'function') reference.releaseReference()
              else if (reference && typeof reference.release === 'function') reference.release()
            } catch (cause) {
              report.releaseError = String(cause)
            }
            post({ phase: 'retain', build: BUILD, at: new Date().toISOString(), ...report, lines })
          }
        }
        run()
      }, [])

      return null
    }

    /**
     * 零尺寸探针：挂在会话头部，把"用户当前正在看的会话"记到模块变量。
     *
     * 为什么需要它：shell.overlay 拿不到当前会话 id（URL 恒为 "/"、
     * usePanelInfo 会违反 hook 规则、sessionListMetadata 只有 {blank,lastPromptAt}），
     * 而 conversation.session.header.actions 的 props 里带 sessionId。
     * 浮标据此排除当前会话，避免"你正看着的这轮结束也弹提醒"的噪音。
     */
    function ActiveSessionProbe(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      React.useEffect(() => {
        activeSessionId = sessionId
      }, [sessionId])
      return null
    }


    return {
      inject: ['slots'],
      // 仅供离线 harness 直接渲染内部组件；宿主只读 inject/apply，多出的键无副作用。
      __internals: DIAG
        ? { PinnedColumn, renderDigestItem, fetchDigest, MultiSessionPanel, SessionCard, LastLine, SendBox, openSession }
        : undefined,
      apply(ctx) {
        rootCtx = ctx
        try {
          ctx.inject(['slots'], (native) => {
            native.slots.inject('conversation.view', () =>
              native.slots.register(
                { name: 'conversation.view', id: VIEW_ID, order: 20, label: () => '多会话' },
                MultiSessionPanel,
              ),
            )
            // 零尺寸探针：记录"当前正在看的会话"，供浮标排除。
            native.slots.inject('conversation.session.header.actions', () =>
              native.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: 'dsh-multi-session-active',
                  order: 90,
                },
                ActiveSessionProbe,
              ),
            )
            if (DIAG) {
              native.slots.inject('shell.overlay', () =>
                native.slots.register(
                  {
                    name: 'shell.overlay',
                    id: 'dsh-multi-session-diag',
                    order: 901,
                    label: 'MultiSession Diag',
                  },
                  DiagOverlay,
                ),
              )
            }
          })
        } catch (cause) {
          console.warn(`${TAG} failed to register the multi-session view`, cause)
        }
      },
    }
  },
})
