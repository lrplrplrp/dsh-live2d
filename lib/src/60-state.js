
  // ══════════════════════════════════════════════════════════════════════
  //  DSH 状态检测（轮询 host 端点）
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：DSH 状态订阅：SSE 实时推送 + 轮询兜底）
  //
  // 注意：状态必须以「事件」而非「渲染快照」的形式驱动动画。
  // 若用 useState + useEffect([dshState]) 观察状态，当 SSE 在同一个事件循环里
  // 连续推送多个状态（例如 THINKING→SPEAKING→SUCCESS），React 18 的自动批处理
  // 会把多次 setState 合并成一次渲染，useEffect 只能看到最后一个值，中间的
  // SPEAKING 被丢弃 —— 这正是「输出对话动画不播放」的原因。
  // 因此这里维护一个有序队列 + 订阅者：每个状态值都会按到达顺序通知一次。

  function createStateFeed() {
    const listeners = new Set()
    // 单调递增的版本号，配合 lastSeen 做去重：仅忽略“完全相同且已处理”的重复推送
    let lastRaw = null
    let queue = []
    let draining = false

    const emit = (state) => {
      queue.push(state)
      drain()
    }

    const drain = () => {
      if (draining) return
      draining = true
      try {
        while (queue.length > 0) {
          const state = queue.shift()
          for (const fn of listeners) {
            try { fn(state) } catch (e) { L2DDBG('state listener error', String(e && e.message || e)) }
          }
        }
      } finally {
        draining = false
      }
    }

    return {
      /** 推送一个状态；与“上一条原始推送”相同则忽略（SSE 重连/轮询回显去重）。 */
      push(state) {
        if (!state || state === lastRaw) return
        lastRaw = state
        L2DDBG('state feed push', 'state=' + state)
        emit(state)
      },
      /** 订阅状态变化，返回取消订阅函数。订阅时会立即收到当前状态。 */
      subscribe(fn) {
        listeners.add(fn)
        if (lastRaw) { try { fn(lastRaw) } catch (e) {} }
        return () => { listeners.delete(fn) }
      },
      get current() { return lastRaw },
      /** SSE 重连后允许重复推送同一状态（重新对齐） */
      reset() { lastRaw = null },
    }
  }

  function useStateDetector() {
    // feed 在组件生命周期内保持稳定
    const feedRef = useRef(null)
    if (!feedRef.current) feedRef.current = createStateFeed()
    const feed = feedRef.current

    useEffect(() => {
      // 优先使用 SSE 实时推送，状态一变更前端立即收到，消除动画触发延迟
      let es = null
      let fallbackTimer = null
      let closed = false

      // 兜底：先立即拉一次，防止 SSE 连接前错过初始状态
      const bootstrap = async () => {
        try {
          const res = await fetch('/plugins/dsh-live2d/state', { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            L2DDBG('poll state recv', 'state=' + data.state)
            if (data.state) feed.push(data.state)
          }
        } catch {}
      }
      bootstrap()

      try {
        es = new EventSource('/plugins/dsh-live2d/state/stream')
        L2DDBG('SSE connecting')
        es.onopen = () => {
          // 重连后允许重新接收与上次相同的状态
          feed.reset()
        }
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data)
            if (data.state) feed.push(data.state)
          } catch {}
        }
        es.onerror = () => {
          L2DDBG('SSE error -> fallback polling')
          // SSE 断开时回退到定时轮询兜底，保证不丢状态
          if (closed || fallbackTimer) return
          fallbackTimer = setInterval(bootstrap, 2000)
        }
      } catch {
        fallbackTimer = setInterval(bootstrap, 2000)
      }

      return () => {
        closed = true
        if (es) es.close()
        if (fallbackTimer) clearInterval(fallbackTimer)
      }
    }, [])

    return feed
  }
