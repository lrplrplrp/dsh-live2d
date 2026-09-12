
  // ══════════════════════════════════════════════════════════════════════
  //  DSH 状态检测（轮询 host 端点）
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：DSH 状态订阅：SSE 实时推送 + 轮询兜底）

  function useStateDetector() {
    const [dshState, setDshState] = useState(DSHState.IDLE)
    const pollTimerRef = useRef(null)

    useEffect(() => {
      // 优先使用 SSE 实时推送，状态一变更前端立即收到，消除动画触发延迟
      let es = null
      let fallbackTimer = null
      let closed = false

      const apply = (state) => { if (state) { L2DDBG('SSE state recv', 'state=' + state); setDshState(state) } }

      // 兜底：先立即拉一次，防止 SSE 连接前错过初始状态
      const bootstrap = async () => {
        try {
          const res = await fetch('/plugins/dsh-live2d/state', { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            L2DDBG('poll state recv', 'state=' + data.state)
            if (data.state) setDshState(data.state)
          }
        } catch {}
      }
      bootstrap()

      try {
        es = new EventSource('/plugins/dsh-live2d/state/stream')
        L2DDBG('SSE connecting')
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data)
            if (data.state) apply(data.state)
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

    return dshState
  }
