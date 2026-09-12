
  // ══════════════════════════════════════════════════════════════════════
  //  主组件
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：主组件：画布挂载、拖拽/缩放交互、画布悬浮控制图标）

  function Live2DWidget() {
    const containerRef = useRef(null)
    const dragHandleRef = useRef(null)
    const controlsRef = useRef(null)
    const engineRef = useRef(null)
    const cleanupDragRef = useRef(null)
    const lastStateRef = useRef(DSHState.IDLE)
    // 状态以事件流方式消费（见 60-state.js 的说明）：不能依赖 React 渲染快照，
    // 否则同一批次里连续到达的多个状态会被批处理合并、中间状态丢失。
    const stateFeed = useStateDetector()

    // 初始化 Live2D
    useEffect(() => {
      if (!containerRef.current) return

      injectCSS()

      const engine = new Live2DEngine()
      engineRef.current = engine

      // 暴露切换接口给设置页（切换模型）
      window.__dshLive2DEngineSwitch = function(idx) {
        engine.switchToModel(idx)
      }

      // 暴露强制切换动画接口给设置页（修改动画映射时立即生效）
      window.__dshLive2DEngineForceSwitch = function(stateName) {
        if (engine.ready) engine.playAnimation(stateName)
      }

      // 暴露眼睛跟随开关接口给设置页
      window.__dshLive2DEngineSetEyeFollow = function(enabled) {
        engine.setEyeFollow(enabled)
      }

      // 暴露点击命中区域开关接口给设置页
      window.__dshLive2DEngineSetHitArea = function(enabled) {
        engine.setHitArea(enabled)
      }

      engine.init(containerRef.current).then((ok) => {
        if (ok) {
          updateControls(containerRef.current, controlsRef.current)
          // 首开判定：按“浏览器会话”而非 DSH 进程全局。sessionStorage 在关闭标签页后
          // 清除、刷新仍在，故“首开/重新打开”会优先播放欢迎（并压过加载期命中的时间映射），
          // 刷新页面不会重复播放欢迎。这样本地预览反复测试都能复现首开行为。
          let isFirstOpen = false
          try {
            isFirstOpen = !window.sessionStorage.getItem('dsh-live2d-welcomed')
          } catch (e) { isFirstOpen = true }
          if (isFirstOpen) {
            // 进入欢迎优先期：临时挂起时间映射，先把欢迎播出来（含语音）。
            engine._welcomePending = true
            // 首开会话抑制时间映射的前提：本模型确实配置了【可播】的欢迎动画。
            // 有有效欢迎动画 → 首开【只播欢迎】，时间映射全程抑制（直到刷新才恢复）；
            // 无欢迎动画（空配置/未设置，如 DeepSeek）→ 不抑制，首开照常触发满足条件的时间映射（带声音）。
            const hasWelcome = engine.hasEffectiveWelcome()
            engine._firstOpenSuppressing = hasWelcome
            engine.playWelcomeFirstOpen()
          } else {
            // 非首开（已播过欢迎）：直接以 IDLE 进入，时间映射照常接管。
            engine._welcomePending = false
            engine.playAnimation('IDLE')
          }
          // 引擎就绪前到达的状态会被 state-feed 跳过，这里用当前值重新对齐一次
          const cur = stateFeed.current
          if (cur && cur !== DSHState.IDLE) {
            L2DDBG('engine ready: resync state', 'state=' + cur)
            const prev = lastStateRef.current
            lastStateRef.current = cur
            const run = async () => {
              if (prev === DSHState.THINKING && cur !== DSHState.THINKING) {
                await engine.playAnimation('THINK_END')
              }
              await engine.playAnimation(cur)
            }
            run()
          }
        }
      })

      cleanupDragRef.current = setupDrag(dragHandleRef.current, containerRef.current, controlsRef.current)

      // 控制浮层（画布大小/拖拽图标）仅在鼠标位于 Live2D 画布上方时显示。
      // 由于容器与 canvas 都是 pointer-events:none（点击穿透不能动），CSS :hover 无法触发，
      // 故用全局 mousemove 命中检测画布矩形；拖拽/缩放进行中时锁定显示，避免图标中途消失。
      const containerEl = containerRef.current
      const controlsEl = controlsRef.current
      let hoverRAF = 0
      const onMouseMove = (e) => {
        if (hoverRAF) return
        hoverRAF = window.requestAnimationFrame(() => {
          hoverRAF = 0
          // engine.canvas 即画布 DOM 元素本身（见 onResizePointerDown 的用法）
          const canvasEl = engine.canvas
          // 画布位于 container 内部，以其实际显示矩形判定鼠标是否悬停其上
          const rect = (canvasEl || containerEl).getBoundingClientRect()
          const inside =
            e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom
          // 拖拽/缩放进行中锁定显示，避免图标中途消失导致操作中断
          const locked = containerEl.classList.contains('interacting')
          if (inside || locked) controlsEl.classList.add('show')
          else controlsEl.classList.remove('show')
        })
      }
      window.addEventListener('mousemove', onMouseMove, true)

      // 窗口尺寸变化时把图标夹回视口内（画布可能因此相对移出屏幕）
      const onResize = () => updateControls(containerRef.current, controlsRef.current)
      window.addEventListener('resize', onResize)

      return () => {
        cleanupDragRef.current?.()
        window.removeEventListener('resize', onResize)
        window.removeEventListener('mousemove', onMouseMove, true)
        if (hoverRAF) window.cancelAnimationFrame(hoverRAF)
        engine.destroy()
      }
    }, [])

    // 订阅 DSH 状态事件流，按到达顺序播放动画（每个状态都不会被丢弃）。
    // 关键：这里用订阅而不是 useEffect([dshState]) —— 后者在 React 批处理下只会
    // 看到最后一个状态，像 THINKING→SPEAKING→SUCCESS 这种连发会丢掉 SPEAKING。
    useEffect(() => {
      // 串行化播放：状态连发时按队列顺序逐个 await，避免并发 playAnimation
      // 互相 _stopCurrentMotion() 把对方掐掉。
      let chain = Promise.resolve()
      let disposed = false
      const enqueue = (task) => {
        chain = chain.then(async () => {
          if (disposed) return
          await task()
        }).catch((e) => {
          L2DDBG('state task error', String(e && e.message || e))
        })
      }

      // 关键：状态一到就尽快播放（尤其是正文开始时的 SPEAKING），不能为了「补足
      // 上一个状态的展示时间」而推迟新状态的开始 —— 那会导致 SPEAKING 要等
      // THINKING 的展示窗口结束才开始，看起来像是「正文都输出完了才触发」。
      // 正确做法：立即切到新状态；仅当上一个状态被顶得过快（< MIN_DWELL_MS）时，
      // 在【切换之前】做一次短暂等待来兜底极短状态，正常交互几乎不触发。
      const MIN_DWELL_MS = 800
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      // 状态变更序号（每次到达 +1）与「上一个已播放状态」的序号/开始时间，
      // 用于判断上一个状态是否被快速顶掉（仅在极短状态时兜底等待）。
      let stateSeq = 0
      let shownSeq = -1
      let shownAt = 0

      const unsubscribe = stateFeed.subscribe((newState) => {
        const engine = engineRef.current
        if (!engine || !engine.ready) {
          L2DDBG('state-feed SKIP (engine not ready)', 'state=' + newState)
          return
        }
        const prevState = lastStateRef.current
        if (newState === prevState) return
        lastStateRef.current = newState
        stateSeq += 1
        const mySeq = stateSeq
        L2DDBG('state-feed recv', 'prev=' + prevState, 'new=' + newState, 'seq=' + mySeq)

        enqueue(async () => {
          // 已播放的状态若展示不足最短时长、且它确实被本次新状态顶掉，
          // 先补足它（避免「闪现即消失」）。注意：这里等待的是【被顶掉的上一个】，
          // 不会推迟真正需要立即呈现的 SPEAKING 之前的 THINKING —— 因为 THINKING
          // 如已展示足够久（思考通常远长于 800ms）则无需等待。
          if (shownSeq !== -1 && shownSeq !== mySeq) {
            const elapsed = Date.now() - shownAt
            if (elapsed < MIN_DWELL_MS) await sleep(MIN_DWELL_MS - elapsed)
          }
          // 思考结束过渡：THINKING → 非 THINKING 时先播一次 THINK_END，再进入新状态
          if (prevState === DSHState.THINKING && newState !== DSHState.THINKING) {
            L2DDBG('state-feed: play THINK_END (transition)', 'for=' + newState)
            await engine.playAnimation('THINK_END')
          }
          L2DDBG('state-feed: play state', 'state=' + newState)
          shownSeq = mySeq
          shownAt = Date.now()
          await engine.playAnimation(newState)
        })
      })

      return () => { disposed = true; unsubscribe() }
    }, [stateFeed])

    // 滚轮缩放：调整模型 scaleX/scaleY
    const onWheel = useCallback((e) => {
      e.preventDefault()
      const engine = engineRef.current
      if (!engine || !engine.ready) return
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
      engine.zoomBy(factor)
      updateControls(containerRef.current, controlsRef.current)
    }, [])

    // 画布大小手柄：拖动右下角改变 canvasWidth/canvasHeight
    const onResizePointerDown = useCallback((e) => {
      e.preventDefault()
      e.stopPropagation()
      const engine = engineRef.current
      const containerEl = containerRef.current
      if (!engine || !engine.ready || !containerEl) return

      const startX = e.clientX
      const startY = e.clientY
      // 起点尺寸必须取 canvas 自身（CSS 像素），不能取 container 的
      // getBoundingClientRect()：container 是 pointer-events:none 且内含一个
      // position:fixed 的控制浮层，某些布局下其 rect 高度会塌缩为 0 / 与画布
      // 不一致，导致 startH 错乱、向下拖时 h 计算异常、画布大小"拖不动"。
      const canvasEl = engine.canvas
      const startW = canvasEl ? canvasEl.offsetWidth : containerEl.getBoundingClientRect().width
      const startH = canvasEl ? canvasEl.offsetHeight : containerEl.getBoundingClientRect().height
      const pointerId = e.pointerId

      try { e.currentTarget.setPointerCapture(pointerId) } catch {}
      // 缩放中锁定控制浮层显示（见主组件的 mousemove 命中检测）
      containerEl.classList.add('interacting')

      const move = (ev) => {
        if (ev.pointerId !== pointerId) return
        const dw = ev.clientX - startX
        const dh = ev.clientY - startY
        // 拖动过程中不夹边（clamp=false）：手柄自由跟随画布右下角，向下拖
        // 时不会被夹在视口底边、鼠标越过后收不到 pointermove 而"拖不动"。
        const w = Math.min(800, Math.max(100, startW + dw))
        const h = Math.min(800, Math.max(100, startH + dh))
        engine.setCanvasSize(w, h)
        updateControls(containerEl, controlsRef.current, false)
      }
      const up = (ev) => {
        if (ev.pointerId !== pointerId) return
        try { e.target.releasePointerCapture(pointerId) } catch {}
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        containerEl.classList.remove('interacting')
        // 松手后把图标夹回视口内（静止状态始终留在网页可见区域）。
        updateControls(containerEl, controlsRef.current, true)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    }, [])

    return h('div', {
      ref: containerRef,
      id: 'dsh-live2d-container',
    },
      // 控制浮层：固定钉在视口右下角，独立于画布。默认隐藏，仅当鼠标悬停在
      // Live2D 画布上方时才显示（由主组件的 mousemove 命中检测切换 .show）。
      h('div', {
        ref: controlsRef,
        id: 'dsh-live2d-controls',
      },
        // 画布大小手柄
        h('div', {
          className: 'dsh-live2d-resize',
          title: '拖动改变画布大小',
          onPointerDown: onResizePointerDown,
        }),
        // 拖拽移动图标：只有拖动它才能移动整个看板娘；
        // 鼠标滚轮也只在这个图标上缩放模型（画布/其他区域不再触发缩放）。
        h('div', {
          ref: dragHandleRef,
          className: 'dsh-live2d-drag',
          title: '拖动移动看板娘；鼠标滚轮缩放模型大小',
          onWheel: onWheel,
        }, '✥'),
      ),
    )
  }
