
  // ══════════════════════════════════════════════════════════════════════
  //  拖动系统
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：拖动移动与画布大小/控制浮层位置维护）

  /**
   * 把归一化位置写回容器。
   * `bottom` 必须置为 auto，否则 left/top 与 bottom 同时生效时浏览器
   * 会优先满足 bottom，拖动看起来"完全没反应"。
   */
  function place(containerEl, x, y) {
    // 画布可自由定位（允许拖出屏幕），仅写入 left/top；bottom 必须置 auto，
    // 否则 left/top 与 bottom 同时生效时浏览器优先满足 bottom，拖动无反应。
    containerEl.style.left = x + 'px'
    containerEl.style.top = y + 'px'
    containerEl.style.bottom = 'auto'
  }

  // 控制浮层跟随画布右下角：clamp=true 时被夹在视口内（画布在屏幕内时图标贴
  // 画布右下角；画布拖出屏幕时图标停在最近屏幕边缘）；clamp=false 时不夹边，
  // 用于拖动画布大小手柄的过程中——否则手柄会被夹在视口底边，鼠标越过后即
  // 收不到 pointermove，表现为"向下拖不动"。
  function updateControls(containerEl, controlsEl, clamp = true) {
    if (!containerEl || !controlsEl) return
    const cr = containerEl.getBoundingClientRect()
    const cs = controlsEl.getBoundingClientRect()
    const w = cs.width || 60
    const h = cs.height || 34
    const OFFSET = 4 // 图标相对画布右下角内缩一点
    const MARGIN = 4 // 离屏幕边缘的最小间距
    let x = cr.right - w - OFFSET
    let y = cr.bottom - h - OFFSET
    if (clamp) {
      x = Math.min(Math.max(x, MARGIN), window.innerWidth - w - MARGIN)
      y = Math.min(Math.max(y, MARGIN), window.innerHeight - h - MARGIN)
    }
    controlsEl.style.left = x + 'px'
    controlsEl.style.top = y + 'px'
    controlsEl.style.right = 'auto'
    controlsEl.style.bottom = 'auto'
  }

  function setupDrag(handleEl, containerEl, controlsEl) {
    let pointerId = null
    let startX = 0
    let startY = 0
    let origX = 0
    let origY = 0
    let dragging = false
    let curX = 0
    let curY = 0

    // 恢复上次位置（并夹回视口，防止窗口缩小后模型跑到屏幕外找不回来）
    const saved = getPosition()
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      place(containerEl, saved.x, saved.y)
    } else {
      // 无本地存档时使用默认位置
      place(containerEl, DEFAULT_POSITION.x, DEFAULT_POSITION.y)
    }

    const finish = () => {
      if (pointerId !== null) {
        try { handleEl.releasePointerCapture(pointerId) } catch {}
      }
      if (dragging) containerEl.classList.remove('dragging')
      containerEl.classList.remove('interacting')
      pointerId = null
      dragging = false
    }

    const onPointerDown = (e) => {
      // 只响应主键（鼠标左键）；触屏/触控笔的 button 恒为 0
      if (e.button !== 0) return
      if (dragging) return

      e.preventDefault()
      e.stopPropagation()
      pointerId = e.pointerId
      dragging = true
      startX = e.clientX
      startY = e.clientY
      // 用 getBoundingClientRect 而不是 offsetLeft/offsetTop：
      // 容器是 position:fixed，offsetParent 为 null，offsetLeft/Top 的基准未定义。
      const rect = containerEl.getBoundingClientRect()
      origX = rect.left
      origY = rect.top
      curX = origX
      curY = origY
      containerEl.classList.add('dragging')
      // 拖拽中锁定控制浮层显示（见主组件的 mousemove 命中检测）
      containerEl.classList.add('interacting')
      // 捕获指针：拖出容器甚至拖出窗口也不断流
      try { handleEl.setPointerCapture(pointerId) } catch {}
    }

    const onPointerMove = (e) => {
      if (!dragging) return
      if (e.pointerId !== pointerId) return

      curX = origX + (e.clientX - startX)
      curY = origY + (e.clientY - startY)
      place(containerEl, curX, curY)
      updateControls(containerEl, controlsEl)
      e.preventDefault()
    }

    const onPointerUp = (e) => {
      if (!dragging) return
      if (e.pointerId !== pointerId) return
      // 存 place() 钳制后的实际显示坐标（视口坐标，对应 position:fixed 的 left/top），
      // 而不是 offsetLeft/offsetTop（那是相对 offsetParent 的，overlay 层原点未必是视口 0,0，
      // 用错会导致刷新后位置错乱、拖动时画布偏离鼠标）。
      const rect = containerEl.getBoundingClientRect()
      savePosition(rect.left, rect.top)
      finish()
    }

    const onPointerCancel = (e) => {
      if (e.pointerId !== pointerId) return
      finish()
    }

    handleEl.addEventListener('pointerdown', onPointerDown)
    // move/up 挂在 window 上：捕获生效前指针可能已经移出手柄
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    // 拖动中丢失指针（例如切窗口）也要复位状态
    window.addEventListener('blur', finish)

    return () => {
      handleEl.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', finish)
      finish()
    }
  }
