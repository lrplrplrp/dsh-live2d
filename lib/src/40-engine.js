
  // ══════════════════════════════════════════════════════════════════════
  //  Live2D 引擎
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：Live2DEngine：渲染、状态动画、时间映射、点击命中、画布缩放）

  class Live2DEngine {
    constructor() {
      this.app = null
      this.model = null
      this.container = null
      this.canvas = null
      this.currentModelIndex = 0
      this.currentTextureIndex = 0
      this.config = null
      this.ready = false
      // 眼睛跟随鼠标：全局开关 + 归一化鼠标坐标（-1~1 范围，0.5 为屏幕中心）
      this.eyeFollow = true
      this.pointer = { x: 0.5, y: 0.5 }
      // 点击命中区域（hit area）全局开关
      this.hitArea = true
      // 循环播放状态：{ group, index } 或 null；motionFinish 时若仍为该状态则重启
      this._loopState = null
      this._loopCooldown = 0
      // 时间映射状态：当前 DSH 状态名 + 当前命中的时间映射下标 + 检查帧计数
      this.currentStateName = 'IDLE'
      this._activeTimeMapping = -1
      this._timeCheckFrame = 0
      // 首开页面：欢迎状态是否正在等待确认（host 返回 welcome 标记）。
      // 为 true 时，加载期不抢触发时间映射，优先把决定权交给欢迎状态。
      this._welcomePending = false
      // 本次首开会话是否仍处于“仅播欢迎、抑制时间映射”状态（首次打开页面为 true，
      // 欢迎标记写入 sessionStorage 后变为 false）。刷新页面会重置 JS 上下文且
      // sessionStorage 已有 welcomed 标记，故刷新后不影响时间映射照常播放。
      this._firstOpenSuppressing = false
      // 首开页面欢迎状态是否已被优先播放（避免与加载期命中的时间映射抢触发）
      this._welcomePlayed = false
      // 时间映射因音频未解锁而推迟播放的标记：解锁后由 checkTimeMappings 补播（带语音）
      this._timeMappingDeferred = false
    }

    async     init(containerEl) {
      this.container = containerEl

      // 首开页面：立即进入“欢迎优先待确认”期，挂起时间映射的自动触发，
      // 直到欢迎标记查询完成（或欢迎播放结束）。这样即便 ticker 在异步查询
      // 窗口内轮询到命中时间段，也不会抢在欢迎之前播放时间映射。
      this._welcomePending = true

      // 从全局配置读取眼睛跟随/点击命中区域开关初始值
      try { this.eyeFollow = getConfig().eyeFollow !== false } catch {}
      if (this.eyeFollow === undefined) this.eyeFollow = true
      try { this.hitArea = getConfig().hitArea !== false } catch {}
      if (this.hitArea === undefined) this.hitArea = true

      const ok = await ensureLibsLoaded()
      if (!ok) return false

      // 安装一次性音频解锁：在首个用户手势中解锁浏览器自动播放策略，
      // 使欢迎动画（页面加载即自动触发，早于任何交互）所附声音也能播放。
      installAudioUnlock()
      // 记录引擎实例，供模块级音频解锁回调在解锁后回放排队的带语音动作
      _engineInstance = this

      const PIXI = window.PIXI
      if (!PIXI) {
        console.error('[dsh-live2d] PIXI not found after loading scripts')
        return false
      }

      const modelList = getConfig()
      // 加载上次切换的模型（持久化），越界则回退到 0
      const activeIdx = getActiveModelIndex(modelList.models)
      const modelEntry = modelList.models[activeIdx]
      if (!modelEntry) return false

      const canvasWidth = modelEntry.canvasWidth || 300
      const canvasHeight = modelEntry.canvasHeight || 400
      const appWidth = canvasWidth * window.devicePixelRatio
      const appHeight = canvasHeight * window.devicePixelRatio

      // 创建 canvas
      this.canvas = document.createElement('canvas')
      this.canvas.width = appWidth
      this.canvas.height = appHeight
      this.canvas.style.width = canvasWidth + 'px'
      this.canvas.style.height = canvasHeight + 'px'
      containerEl.appendChild(this.canvas)

      // 点击交互：画布保持 pointer-events:none，鼠标事件（含滚轮）原生穿透给页面；
      // hit area 的命中检测在 document 捕获阶段完成（见 _setupCanvasInteraction）。
      this._setupCanvasInteraction()

      // 创建 PIXI 应用
      this.app = new PIXI.Application({
        width: appWidth,
        height: appHeight,
        view: this.canvas,
        autoStart: true,
        transparent: true,
        backgroundAlpha: 0,
      })

      // 加载模型
      await this.loadModel(activeIdx, 0)

      // 眼睛跟随鼠标：监听全局鼠标移动，记录指针在画布（容器）内的本地坐标，
      // 每帧调用 pixi-live2d-display 内置的 model.focus(x, y) 让视线看向指针位置。
      this._onPointerMove = (e) => {
        const el = this.container
        if (!el) return
        const rect = el.getBoundingClientRect()
        // 鼠标相对容器左上角的像素坐标（与画布像素一致，即模型未缩放前的本地坐标）
        this.pointer.x = e.clientX - rect.left
        this.pointer.y = e.clientY - rect.top
      }
      window.addEventListener('mousemove', this._onPointerMove)

      this.app.ticker.add(this._eyeFollowTick = () => {
        if (!this.model || !this.model.internalModel) return
        if (this.eyeFollow) {
          try { this.model.focus(this.pointer.x, this.pointer.y) } catch {}
        } else {
          try { this.model.focus(0, 0) } catch {}
        }
        // 时间映射：每 120 帧（约 2 秒）检查一次时间条件，命中/离开时间段时切换动画。
        // 首开欢迎期由 _welcomePending/_firstOpenSuppressing 在 checkTimeMappings 内部守卫，
        // 这里照常调度即可，不会抢触发。
        this._timeCheckFrame = (this._timeCheckFrame || 0) + 1
        if (this._timeCheckFrame % 120 === 0) this.checkTimeMappings()
        // 循环播放：loop 状态激活且当前没有 motion 在播时，重启当前动作（带冷却避免抖动）
        if (this._loopState && this._loopState.index !== null) {
          if (this._loopCooldown > 0) {
            this._loopCooldown -= 1
          } else {
            let playing = false
            try {
              const mm = this.model.internalModel.motionManager
              playing = !!(mm && mm.currentMotion)
            } catch {}
            if (!playing) {
              this._loopCooldown = 6 // 重启后冷却帧
              try { this.model.motion(this._loopState.group, this._loopState.index) } catch {}
            }
          }
        }
      })

      this.ready = true
      return true
    }

    async loadModel(modelId, textureId) {
      if (!this.app) return

      const PIXI = window.PIXI
      const live2d = PIXI.live2d
      if (!live2d) return

      const modelList = getConfig()
      const modelEntry = modelList.models[modelId]
      if (!modelEntry) return

      this.currentModelIndex = modelId
      this.currentTextureIndex = textureId

      try {
        // 移除旧模型
        if (this.model) {
          this.app.stage.removeChild(this.model)
          this.model.destroy()
          this.model = null
        }

        // 解析模型路径（此时已经是完整的本地 URL）
        const modelUrl = this.resolveUrl(modelEntry.url, textureId)
        console.log('[dsh-live2d] Loading model from:', modelUrl)

        // 加载新模型
        this.model = await live2d.Live2DModel.from(modelUrl)
        this.app.stage.addChild(this.model)
        this.model.buttonMode = false
        // 点击 hit area 由本插件在 canvas 上统一处理，禁用模型自带的
        // autoInteract(pointertap) 以避免重复触发/冲突
        try { this.model.autoInteract = false } catch {}

        // 自动调整大小和位置
        this.autoSetTransform(modelEntry)

        // 绑定点击区域
        this.drawHitArea()

        // 模型切换后清除循环/时间映射状态，避免对不存在的 group/动作重启
        this._loopState = null
        this._activeTimeMapping = -1
        this.currentStateName = 'IDLE'

        // 模型就绪：淡入显示画布（从透明渐显，贝塞尔先快后慢）
        this._fadeInCanvas()

        console.log('[dsh-live2d] Model ' + modelId + '-' + textureId + ' loaded')
      } catch (err) {
        console.error('[dsh-live2d] Failed to load model:', err)
      }
    }

    resolveUrl(basePath, textureId) {
      if (typeof basePath === 'string') return basePath
      if (Array.isArray(basePath)) return basePath[textureId] || basePath[0]
      return basePath
    }

    autoSetTransform(modelEntry) {
      if (!this.model || !this.app) return

      const appWidth = this.app.renderer.width
      const appHeight = this.app.renderer.height
      const originalHeight = this.model.internalModel.originalHeight
      const originalWidth = this.model.internalModel.originalWidth

      const h = appHeight / originalHeight
      const w = appWidth / originalWidth
      const min = Math.min(h, w)

      if (modelEntry.config) {
        const cfg = modelEntry.config
        this.model.scale.set(cfg.scaleX * min, cfg.scaleY * min)
        this.model.y = (appHeight - this.model.height) / 2 + (cfg.y || 0)
        this.model.x = (appWidth - this.model.width) / 2 + (cfg.x || 0)
      } else {
        this.model.scale.set(min)
        this.model.y = (appHeight - this.model.height) / 2
        this.model.x = (appWidth - this.model.width) / 2
      }
    }

    drawHitArea() {
      if (!this.model) return
      try {
        const model = this.model
        // 记录模型是否定义了可点击的 hit area。canvas 始终保持
        // pointer-events:none（不拦截任何鼠标事件），hit area 的命中检测
        // 放在 document 捕获阶段完成，见 handleCanvasClick。
        this._hasHitAreas = Object.keys(model.internalModel.hitAreas).length > 0
      } catch {}
    }

    // 模型就绪后淡入画布：从透明（opacity:0）渐显到不透明，使用 CSS transition
    // 的贝塞尔曲线（先快后慢）。double requestAnimationFrame 确保先绘制出
    // 透明帧、再开始过渡，避免浏览器跳过淡入直接显示。
    _fadeInCanvas() {
      if (!this.canvas) return
      const canvas = this.canvas
      canvas.style.opacity = '0'
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          try { canvas.style.opacity = '1' } catch {}
        })
      })
    }

    // 画布保持 pointer-events:none，鼠标滚轮/点击都会原生穿透给页面下层；
    // 这里在 document 捕获阶段"旁听"点击：命中 hit area 时触发 Tap 动画，
    // 但不消费事件（不 preventDefault/stopPropagation），页面仍能收到点击。
    _setupCanvasInteraction() {
      if (this._onCanvasClick) return
      this._onCanvasClick = (e) => this.handleCanvasClick(e)
      document.addEventListener('click', this._onCanvasClick, true)
    }

    handleCanvasClick(e) {
      if (!this.model || !this.canvas) return
      // 通用设置中关闭点击命中区域后，不再做 hit area 检测（点击仍原生穿透）
      if (!this.hitArea) return
      // 点击的是控制浮层图标（拖拽/画布大小手柄）时不触发 Tap
      try {
        if (e.target && e.target.closest && e.target.closest('#dsh-live2d-controls')) return
      } catch {}
      // 点击不在画布矩形内则忽略（点击画布外的页面元素不受影响）
      const rect = this.canvas.getBoundingClientRect()
      const x = e.clientX
      const y = e.clientY
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return
      let hits = []
      try {
        if (this.model.hitTest && this._hasHitAreas) {
          // model.hitTest 接收 PIXI 全局坐标：以 canvas 左上角为原点，单位是
          // 画布实际像素（CSS 像素 × devicePixelRatio）。因此要把视口坐标先减去
          // canvas 边界偏移，再乘上 renderer.width/rect.width 换算系数，否则
          // 高分屏/缩放画布或模型后，命中区域不会跟随模型的视觉位置。
          const ratioX = this.app && rect.width > 0 ? this.app.renderer.width / rect.width : 1
          const ratioY = this.app && rect.height > 0 ? this.app.renderer.height / rect.height : 1
          const gx = (x - rect.left) * ratioX
          const gy = (y - rect.top) * ratioY
          hits = this.model.hitTest(gx, gy) || []
        }
      } catch {}
      // 命中 hit area 则触发 Tap 动画；点击本身仍然原生穿透给页面下层
      for (const area of hits) {
        this.triggerMotion('Tap' + area)
      }
    }

    // ── 动画控制 ──────────────────────────────────────────────────────

    async playAnimation(stateName) {
      if (!this.model) { L2DDBG('playAnimation SKIP (no model)', 'state=' + stateName); return }

      // 记录当前 DSH 状态（时间映射仅在空闲状态生效）
      L2DDBG('playAnimation called', 'state=' + stateName, 'prevState=' + this.currentStateName)
      this.currentStateName = stateName

      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (!modelEntry || !modelEntry.animations) {
        L2DDBG('playAnimation SKIP (no modelEntry/animations)', 'state=' + stateName, 'hasEntry=' + !!modelEntry)
        return
      }
      L2DDBG('playAnimation config lookup', 'state=' + stateName,
        'anim=' + JSON.stringify(modelEntry.animations[stateName] || null))

      // 空闲状态：时间映射优先——当前时间命中某时间段时，播放该时间段的动画
      if (stateName === 'IDLE') {
        // 首开会话“仅播欢迎”：完全不触发时间映射
        if (this._firstOpenSuppressing) { return }
        // 首开页面欢迎待确认期：暂不抢触发时间映射，等欢迎状态决定
        if (this._welcomePending) { return }
        const mappings = this.getTimeMappings()
        const idx = this.findActiveTimeMapping(mappings)
        if (idx >= 0) {
          // 音频未解锁（页面加载期、早于任意用户手势）：时间映射语音会被自动播放策略
          // 静音，故整体推迟，先不播；记录命中下标，待首次手势解锁后由 checkTimeMappings 补播
          // （动作+语音一同出声）。已解锁则直接播，并记录命中下标。
          if (!_audioUnlocked) {
            this._activeTimeMapping = idx
            this._timeMappingDeferred = true
            return
          }
          const played = await this._applyAnimConfig(mappings[idx].animation, 'timemapping')
          if (played) this._activeTimeMapping = idx
          return
        }
        this._activeTimeMapping = -1
      } else {
        // 非空闲状态：清除时间映射（DSH 状态动画优先）
        this._activeTimeMapping = -1
      }

      const anim = modelEntry.animations[stateName]
      await this._applyAnimConfig(anim, stateName)
    }

    // 播放“自动动画”动作（欢迎 / 时间映射）。这类动画在页面加载期即触发，
    // 早于任意用户手势；音频尚未解锁时直接播放会被自动播放策略静音，故推迟到
    // 首次用户手势解锁后再播，确保动作与语音一同出现。已解锁则直接播。
    // 来自用户主动交互的状态（点击/状态切换）不在其列，它们本就发生在手势之后。
    async playAutoMotion(group, index, reason) {
      if (!this.model) return false
      if (_audioUnlocked) {
        // 已解锁：直接播
        L2DDBG('playAutoMotion PLAY', 'reason=' + reason, 'group=' + group, 'index=' + index)
        await this.triggerMotion(group, index, reason)
        return true
      }
      // 未解锁：记录目标，待解锁后补播（仅保留最近一个；欢迎优先于时间映射）
      L2DDBG('playAutoMotion DEFER (audio locked!)', 'reason=' + reason, 'group=' + group, 'index=' + index)
      _deferredAuto = 'timemapping'
      return false
    }

    // 当前模型是否“真正配置了可播的欢迎动画”：WELCOME 必须存在且含有效 motion.group
    // 或 expression。空对象 / 缺字段的残留配置一律算“未设置”，首开会照常触发时间映射。
    hasEffectiveWelcome() {
      const cfg = getConfig()
      const me = cfg && cfg.models && cfg.models[this.currentModelIndex]
      const w = me && me.animations ? me.animations.WELCOME : null
      if (!w || typeof w !== 'object') return false
      const motionOk = !!(w.motion && typeof w.motion.group === 'string' && w.motion.group.length > 0)
      const exprOk = !!(w.expression && typeof w.expression === 'string' && w.expression.length > 0)
      return motionOk || exprOk
    }

    // 首开页面优先播放欢迎状态：使加载期命中的“时间映射”让位给欢迎动画
    // （避免两者抢触发）。音频未解锁时整段（动作+语音）推迟到首次用户手势后再播；
    // 已解锁则立即播放。欢迎动作（非循环）播放完毕后，自动把状态交回 IDLE，
    // 由时间映射接管。
    async playWelcomeFirstOpen() {
      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      // 仅当 WELCOME 配置“有效可播”时才视为有欢迎动画；空/残留配置按无处理
      const anim = this.hasEffectiveWelcome() && modelEntry && modelEntry.animations ? modelEntry.animations.WELCOME : null
      // 进入欢迎优先期：挂起时间映射，直到欢迎结束
      this._welcomePending = true
      // 记录“本次会话已播欢迎”，刷新不会再触发（会话关闭后清除，重开复现首开）
      try { window.sessionStorage.setItem('dsh-live2d-welcomed', '1') } catch (e) {}
      if (!anim || _audioUnlocked) {
        // 无有效欢迎动画 / 音频已解锁：立即播放（欢迎优先于加载期的时间映射）
        await this._playWelcomeNow()
        return
      }
      // 音频未解锁：整段欢迎（动作+语音）延迟到首次用户手势后播放；欢迎优先
      // 于时间映射，故直接覆盖其待播目标，并丢弃被推迟的时间映射（欢迎优先）。
      _deferredAuto = 'welcome'
      this._timeMappingDeferred = false
    }

    async _playWelcomeNow() {
      this._welcomePlayed = true
      // 用与判定一致的严格口径：空/缺字段的残留 WELCOME 配置视为“无欢迎动画”，
      // 避免空 {} 被当成有动画而进入只播欢迎分支（导致时间映射也被抑制、啥都不播）。
      const anim = this.hasEffectiveWelcome() ? (() => {
        const cfg = getConfig()
        const me = cfg && cfg.models && cfg.models[this.currentModelIndex]
        return me && me.animations ? me.animations.WELCOME : null
      })() : null
      if (!anim) {
        // 无有效欢迎动画（如 DeepSeek / 空配置）：优先期结束，交回 IDLE，让时间映射接管
        this._firstOpenSuppressing = false
        this._welcomePlayed = false
        this._welcomePending = false
        this.currentStateName = 'IDLE'
        this.checkTimeMappings()
        return
      }
      this.currentStateName = 'WELCOME'
      // 若欢迎配置只写了 group 没写 index（如 { motion: { group: 'Start' } }），
      // 默认取第 0 个动作（确定播放，而非整组随机）。
      let welcomeAnim = anim
      if (anim.motion && typeof anim.motion.group === 'string' && typeof anim.motion.index !== 'number') {
        welcomeAnim = { ...anim, motion: { ...anim.motion, index: 0 } }
      }
      try {
        await this._applyAnimConfig(welcomeAnim, 'welcome')
      } catch {}
      // 有欢迎动画：首开【只播欢迎】，时间映射全程抑制，停留结束后不再交回时间映射
      // （_firstOpenSuppressing 保持 true，ticker 与手动调用都不会播时间映射）。刷新页面后
      // JS 上下文重置且 sessionStorage 已有 welcomed 标记，isFirstOpen=false，不再抑制。
    }

    // 应用一份动画配置（motion/expression/loop），供状态动画与时间映射共用
    async _applyAnimConfig(anim, reason) {
      if (!anim) { L2DDBG('_applyAnimConfig SKIP (anim empty)', 'reason=' + reason); return }
      L2DDBG('_applyAnimConfig', 'reason=' + reason,
        'motion=' + JSON.stringify(anim.motion || null), 'expr=' + (anim.expression || '-'),
        'loop=' + (anim.loop === true))

      // 切换状态：先清除旧的循环状态（避免重启已停止的动作），再据本状态是否循环设定
      this._loopState = null

      // 循环播放状态：记录当前动作，ticker 检测到动作播完时自动重启
      if (anim.loop === true && anim.motion) {
        this._loopState = {
          group: anim.motion.group,
          index: typeof anim.motion.index === 'number' ? anim.motion.index : null,
        }
      }

      if (anim.motion) {
        // 支持整组动画：未指定 index 时随机播放组内一个 motion
        if (typeof anim.motion.index === 'number') {
          return await this.playAutoMotion(anim.motion.group, anim.motion.index, reason)
        }
        await this.triggerMotionGroup(anim.motion.group, reason)
      }
      if (anim.expression) {
        this.triggerExpression(anim.expression)
      }
      return true
    }

    // ── 时间映射 ──────────────────────────────────────────────────────

    // 当前模型的时间映射列表：[{ start: 'HH:MM', end: 'HH:MM', animation: {...} }]
    getTimeMappings() {
      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      return modelEntry && Array.isArray(modelEntry.timeMappings) ? modelEntry.timeMappings : []
    }

    // "HH:MM" → 分钟数；非法返回 null
    // 结果按字符串缓存（"HH:MM" 取值有限），避免 ticker 每轮对同一时间段重复正则解析。
    _parseTimeToMinutes(str) {
      if (!str || typeof str !== 'string') return null
      if (_timeParseCache.has(str)) return _timeParseCache.get(str)
      const m = str.match(/^(\d{1,2}):(\d{2})$/)
      let result = null
      if (m) {
        const h = parseInt(m[1], 10)
        const min = parseInt(m[2], 10)
        if (!isNaN(h) && !isNaN(min) && h <= 23 && min <= 59) result = h * 60 + min
      }
      _timeParseCache.set(str, result)
      return result
    }

    // 当前时间（分钟数）是否落在映射的时间段内；支持跨午夜（如 22:00–06:00）
    _timeInRange(mapping, minutes) {
      const start = this._parseTimeToMinutes(mapping && mapping.start)
      const end = this._parseTimeToMinutes(mapping && mapping.end)
      if (start === null || end === null) return false
      if (start <= end) return minutes >= start && minutes <= end
      // 跨午夜：22:00–06:00 → 22:00≤t 或 t≤06:00
      return minutes >= start || minutes <= end
    }

    // 返回当前命中的时间映射下标；未命中返回 -1
    findActiveTimeMapping(mappings) {
      if (!Array.isArray(mappings) || mappings.length === 0) return -1
      const now = new Date()
      const minutes = now.getHours() * 60 + now.getMinutes()
      for (let i = 0; i < mappings.length; i++) {
        if (this._timeInRange(mappings[i], minutes)) return i
      }
      return -1
    }

    // ticker 周期性调用：空闲状态下，时间进入/离开时间段时自动切换对应动画
    async checkTimeMappings() {
      if (!this.model) return
      // 首开会话：仅播欢迎，完全抑制时间映射（刷新后 _firstOpenSuppressing 为 false，照常）
      if (this._firstOpenSuppressing) {
        this._activeTimeMapping = -1
        this._timeMappingDeferred = false
        return
      }
      // 首开欢迎优先期：等待确认及欢迎动作播完前，不抢触发时间映射
      if (this._welcomePending || this._welcomePlayed) return
      // 非空闲状态不参与时间映射（DSH 状态动画优先），且清除已命中的映射
      if (this.currentStateName !== 'IDLE') {
        if (this._activeTimeMapping !== -1) this._activeTimeMapping = -1
        this._timeMappingDeferred = false
        return
      }
      const mappings = this.getTimeMappings()
      const idx = this.findActiveTimeMapping(mappings)
      // 已处于该时间段且非“待补播”状态时跳过，避免重复触发
      if (idx === this._activeTimeMapping && !this._timeMappingDeferred) return
      this._activeTimeMapping = idx
      this._timeMappingDeferred = false
      if (idx >= 0) {
        // 音频尚未解锁（早于任意用户手势）时，时间映射语音会被自动播放策略静音，
        // 故整体推迟——记录命中下标，待首次手势解锁后由 unlockAudioOnce 补播（动作+语音一同出声）。
        if (!_audioUnlocked) {
          if (this._timeMappingDeferred && this._activeTimeMapping === idx) return
          this._activeTimeMapping = idx
          this._timeMappingDeferred = true
          return
        }
        await this._applyAnimConfig(mappings[idx].animation, 'timemapping')
      } else {
        // 离开时间段：恢复默认空闲动画
        const modelList = getConfig()
        const modelEntry = modelList.models[this.currentModelIndex]
        const idleAnim = modelEntry && modelEntry.animations ? modelEntry.animations.IDLE : null
        await this._applyAnimConfig(idleAnim, 'idle')
      }
    }

    // 强制切换：先停止当前正在播放的 motion（含循环中的），再播放新的，避免动画叠加
    _stopCurrentMotion() {
      if (!this.model) return
      try {
        const mm = this.model.internalModel.motionManager
        if (mm && typeof mm.stopAllMotions === 'function') {
          mm.stopAllMotions()
        }
      } catch {}
    }

    // 随机播放某个 motion 组里的一个动作（loop 模式会锁定该 index 持续循环）
    async triggerMotionGroup(group, reason) {
      if (!this.model || !group) { L2DDBG('triggerMotionGroup SKIP', 'group=' + group, 'reason=' + reason); return }
      try {
        const defs = this.model.internalModel.motionManager.definitions[group] || []
        L2DDBG('triggerMotionGroup', 'group=' + group, 'defCount=' + defs.length, 'reason=' + reason)
        if (defs.length === 0) return
        const index = Math.floor(Math.random() * defs.length)
        // 若处于循环状态且未指定具体 index，锁定本次随机到的 index
        if (this._loopState && this._loopState.index === null) this._loopState.index = index
        await this.triggerMotion(group, index, reason)
      } catch (e) { L2DDBG('triggerMotionGroup ERROR', String(e && e.message || e)) }
    }

    async triggerMotion(group, index, reason) {
      if (!this.model) return
      // 强制切换掉正在播放的动画（含循环中的）
      this._stopCurrentMotion()
      try {
        await this.model.motion(group, index)
        L2DDBG('triggerMotion OK', 'group=' + group, 'index=' + index, 'reason=' + reason)
      } catch (e) { L2DDBG('triggerMotion ERROR', 'group=' + group, 'index=' + index, String(e && e.message || e)) }
    }

    triggerExpression(expressionName) {
      if (!this.model) return
      try {
        const em = this.model.internalModel.motionManager.expressionManager
        if (em) {
          em.setExpression(expressionName)
          setTimeout(() => {
            try {
              em.resetExpression()
              em.currentExpression = em.defaultExpression
            } catch {}
          }, 4000)
        }
      } catch {}
    }

    resize(canvasWidth, canvasHeight) {
      if (!this.app || !this.canvas) return

      const appWidth = canvasWidth * window.devicePixelRatio
      const appHeight = canvasHeight * window.devicePixelRatio

      this.app.renderer.resize(appWidth, appHeight)
      this.canvas.style.width = canvasWidth + 'px'
      this.canvas.style.height = canvasHeight + 'px'

      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (modelEntry) this.autoSetTransform(modelEntry)
    }

    // 缩放（滚轮）：调整当前模型的 scaleX/scaleY 并持久化
    zoomBy(factor) {
      if (!this.model) return
      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (!modelEntry) return

      const clamp = (v) => Math.min(5, Math.max(0.1, v))
      const next = {
        x: modelEntry.config?.x || 0,
        y: modelEntry.config?.y || 0,
        scaleX: clamp((modelEntry.config?.scaleX || 1) * factor),
        scaleY: clamp((modelEntry.config?.scaleY || 1) * factor),
      }
      modelEntry.config = next
      saveConfig(modelList)
      this.autoSetTransform(modelEntry)
    }

    // 直接调整画布宽高（拖拽画布大小手柄时调用）
    setCanvasSize(width, height) {
      if (!this.app || !this.canvas) return
      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (!modelEntry) return
      modelEntry.canvasWidth = Math.round(width)
      modelEntry.canvasHeight = Math.round(height)
      saveConfig(modelList)
      this.resize(modelEntry.canvasWidth, modelEntry.canvasHeight)
    }

    // 强制切换到指定模型（设置页"切换模型"按钮触发）
    async switchToModel(modelIndex) {
      if (!this.app) return
      const modelList = getConfig()
      if (!modelList.models[modelIndex]) return
      await this.loadModel(modelIndex, 0)
      // 持久化当前模型，刷新后保持
      saveActiveModelIndex(modelIndex)
      // 用户主动切换模型：结束首开“仅播欢迎”抑制，让新模型的时间映射正常生效
      // （否则在首开窗口内切模型会一直不播时间映射，直到刷新）
      this._firstOpenSuppressing = false
      this._welcomePending = false
      this.playAnimation('IDLE')
    }

    destroy() {
      if (this._onCanvasClick) {
        try { document.removeEventListener('click', this._onCanvasClick, true) } catch {}
        this._onCanvasClick = null
      }
      if (this._onPointerMove) {
        window.removeEventListener('mousemove', this._onPointerMove)
        this._onPointerMove = null
      }
      if (this.app && this._eyeFollowTick) {
        try { this.app.ticker.remove(this._eyeFollowTick) } catch {}
        this._eyeFollowTick = null
      }
      if (this.model) {
        try { this.model.destroy() } catch {}
        this.model = null
      }
      if (this.app) {
        try { this.app.destroy(true) } catch {}
        this.app = null
      }
      this.ready = false
    }

    // 设置眼睛跟随鼠标开关（保存到全局配置并在引擎中生效）
    setEyeFollow(enabled) {
      this.eyeFollow = !!enabled
      const modelList = getConfig()
      modelList.eyeFollow = this.eyeFollow
      saveConfig(modelList)
    }

    // 设置点击命中区域（hit area）开关（保存到全局配置并在引擎中生效）
    setHitArea(enabled) {
      this.hitArea = !!enabled
      const modelList = getConfig()
      modelList.hitArea = this.hitArea
      saveConfig(modelList)
    }
  }
