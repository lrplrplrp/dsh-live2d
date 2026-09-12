// dsh-live2d — Client (browser) side.
//
// DSH 插件：在 Web GUI 中渲染 Live2D 看板娘模型。
//
// 功能：
//   - Live2D 模型渲染（PIXI.js + pixi-live2d-dsl，全部本地加载）
//   - 鼠标拖动移动位置
//   - DSH 状态驱动动画（思考/工作/完成/错误）
//   - 设置页：模型列表编辑、画布大小配置、动画映射
//   - 支持本地模型导入
//
// 移除了原项目的：对话框、小飞机游戏、关闭/关于/GitHub 按钮。

window.__ModuleLoader__.load({ id: '@lrplrplrp/dsh-live2d', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  const React = require('react')
  const { useState, useEffect, useRef, useCallback } = React
  const h = React.createElement

  // ══════════════════════════════════════════════════════════════════════
  //  常量 & 配置
  // ══════════════════════════════════════════════════════════════════════

  const STORAGE_KEY = 'dsh-live2d.v1'
  const POSITION_KEY = 'dsh-live2d.position'
  const ACTIVE_MODEL_KEY = 'dsh-live2d.activeModel'

  // 容器默认屏幕位置（无本地存档时使用），对应 position:fixed 的 left/top
  const DEFAULT_POSITION = { x: 1240, y: 330 }

  // 本地文件路由前缀（由 host 端 index.js 注册）
  const LIB_BASE = '/plugins/dsh-live2d/lib/'
  const ASSETS_BASE = '/plugins/dsh-live2d/assets/'

  // 需要按顺序加载的本地库文件
  const LIB_SCRIPTS = [
    'pixi.min.js',
    'live2d.min.js',
    'live2dcubismcore.min.js',
    'index.min.js',
  ]

  const DSHState = {
    IDLE: 'IDLE',
    THINKING: 'THINKING',
    WORKING: 'WORKING',
    SPEAKING: 'SPEAKING',
    SUCCESS: 'SUCCESS',
    ERROR: 'ERROR',
  }

  const ANIMATION_STATES = ['WELCOME', 'IDLE', 'THINKING', 'THINK_END', 'WORKING', 'SPEAKING', 'SUCCESS', 'ERROR']

  const ANIMATION_STATE_LABELS = {
    WELCOME: '欢迎',
    IDLE: '空闲',
    THINKING: '开始思考',
    THINK_END: '思考结束',
    WORKING: '工具调用',
    SPEAKING: '输出对话',
    SUCCESS: '任务完成',
    ERROR: '任务出错',
  }

  const DEFAULT_MODEL_LIST = {
    models: [{
      name: 'DeepSeek',
      url: ASSETS_BASE + 'deepseek_l2d/deepseek.model3.json',
      canvasWidth: 300,
      canvasHeight: 400,
      config: { x: 0, y: 0, scaleX: 1.5, scaleY: 1.5 },
      animations: {
        WELCOME: { motion: { group: 'Idle', index: 0 }, loop: false },
        IDLE: { motion: { group: 'Idle', index: 0 }, loop: false },
        THINKING: { motion: { group: 'Anima', index: 2 }, loop: true },
        THINK_END: { motion: { group: 'Anima', index: 1 }, loop: false },
        WORKING: { expression: 'puzzled' },
        SPEAKING: { motion: { group: 'Anima', index: 0 }, loop: true },
        SUCCESS: { expression: 'happy' },
        ERROR: { expression: 'unhappy' },
      },
    }],
    // 眼睛是否跟随鼠标（全局开关）
    eyeFollow: true,
    // 点击命中区域开关（全局开关，默认开启）
    hitArea: true,
  }

  // ══════════════════════════════════════════════════════════════════════
  //  配置管理（localStorage 持久化）
  // ══════════════════════════════════════════════════════════════════════

  // 规范化配置：保证 models 一定是数组，且每个 model 的动画相关字段都是数组。
  // 兼容早期脏数据（如 models 被存成对象 {} 而非数组，或字段缺失）。
  function normalizeConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') cfg = {}
    var models = cfg.models
    if (!Array.isArray(models)) models = []
    models = models.map(function(m) {
      if (!m || typeof m !== 'object') return { name: '', url: '', groups: [], groupCounts: {}, groupMotions: {}, expressions: [], animations: {}, timeMappings: [] }
      return {
        name: m.name || '',
        url: m.url || '',
        canvasWidth: m.canvasWidth || 300,
        canvasHeight: m.canvasHeight || 400,
        config: m.config || { x: 0, y: 0, scaleX: 1, scaleY: 1 },
        groups: Array.isArray(m.groups) ? m.groups : [],
        groupCounts: m.groupCounts && typeof m.groupCounts === 'object' ? m.groupCounts : {},
        groupMotions: m.groupMotions && typeof m.groupMotions === 'object' ? m.groupMotions : {},
        expressions: Array.isArray(m.expressions) ? m.expressions : [],
        animations: m.animations && typeof m.animations === 'object' ? m.animations : {},
        // 时间映射：[{ start: 'HH:MM', end: 'HH:MM', animation: {...} }]
        timeMappings: Array.isArray(m.timeMappings) ? m.timeMappings : [],
      }
    })
    return Object.assign({}, cfg, { models: models, eyeFollow: cfg.eyeFollow === false ? false : true, hitArea: cfg.hitArea === false ? false : true })
  }

  // 配置在内存中缓存一份：缩放 / 拖动画布这类高频操作需要在内存里连续累加，
  // 不能每次都从 localStorage 重新解析（否则上一次的防抖写入还没落盘，会读到旧值）。
  // 读取一律走缓存，写入由 saveConfig 防抖落盘，保证内存与持久化一致。
  let _configCache = null

  function getConfig() {
    if (_configCache) return _configCache
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      _configCache = raw
        ? normalizeConfig(JSON.parse(raw))
        : normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_MODEL_LIST)))
    } catch {
      _configCache = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_MODEL_LIST)))
    }
    return _configCache
  }

  let _saveTimer = null
  function saveConfig(cfg) {
    // 始终以传入对象（或当前缓存）作为权威状态，确保与内存一致
    if (cfg) _configCache = cfg
    if (_saveTimer) clearTimeout(_saveTimer)
    _saveTimer = setTimeout(function() {
      _saveTimer = null
      try {
        if (_configCache) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(_configCache))
      } catch {}
    }, 150)
  }

  // 立即落盘：在页面卸载/隐藏前把待写的配置同步刷入 localStorage，
  // 避免 debounce 窗口内（150ms）用户关闭页面导致最后一次修改丢失。
  function flushConfig() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null }
    try {
      if (_configCache) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(_configCache))
    } catch {}
  }
  window.addEventListener('pagehide', flushConfig)
  window.addEventListener('beforeunload', flushConfig)

  function getPosition() {
    try {
      const raw = window.localStorage.getItem(POSITION_KEY)
      if (!raw) return null
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function savePosition(x, y) {
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x, y }))
    } catch {}
  }

  function getActiveModelIndex(models) {
    let idx = 0
    try {
      const raw = window.localStorage.getItem(ACTIVE_MODEL_KEY)
      if (raw !== null) {
        const n = parseInt(raw, 10)
        if (Number.isFinite(n) && n >= 0 && n < models.length) idx = n
      }
    } catch {}
    return idx
  }

  function saveActiveModelIndex(idx) {
    try {
      window.localStorage.setItem(ACTIVE_MODEL_KEY, String(idx))
    } catch {}
  }

  // ══════════════════════════════════════════════════════════════════════
  //  本地库加载器（通过 host 端 webserver 路由）
  // ══════════════════════════════════════════════════════════════════════

  let libsLoaded = false

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + url + '"]')) {
        resolve()
        return
      }
      const script = document.createElement('script')
      script.src = url
      script.onload = resolve
      script.onerror = function() { reject(new Error('Failed to load ' + url)) }
      document.head.appendChild(script)
    })
  }

  async function ensureLibsLoaded() {
    if (libsLoaded) return true
    try {
      for (const name of LIB_SCRIPTS) {
        await loadScript(LIB_BASE + name)
      }
      libsLoaded = true
      return true
    } catch (err) {
      console.warn('[dsh-live2d] Failed to load Live2D libraries from local server:', err)
      return false
    }
  }

  // 浏览器自动播放策略允许在用户手势（点击/按键/触摸）中播放音频。
  // Live2D 显示库用裸 HTMLAudioElement.play() 播放动作附带的语音，欢迎动画
  // 在页面加载后立即自动触发（早于任何用户交互），其 play() 会被浏览器拦截
  // —— 动作照常播放，但声音被静默丢弃。其余状态均在用户已交互后才触发，故
  // 能正常出声。这里在首次用户手势中用一段 1 采样静音 wav 解锁音频，确保
  // 浏览器自动播放策略：页面加载后、任意用户手势前，直接 audio.play() 会被静默拦截。
  // 因此“加载期即触发”的自动动画（欢迎、时间映射）会只剩动作、没有声音。处理策略：
  // 在音频未解锁前，这类自动动画【整体推迟播放】，不真正播放；待首次用户手势
  // （pointerdown/keydown/touchstart）解锁音频后，再补播（动作+语音一同出现）。
  // 注意：不依赖“播放静音 WAV 是否 resolve”来预判能否自动播放——部分浏览器即便
  // 实际会拦截语音，也会让静音 WAV 的 play() resolve，导致误判已解锁而仍被静音。
  // 故只以真实用户手势作为解锁信号（与首版欢迎修复一致）。推迟是“动作+语音”一起的，
  // 不做逐动作语音探测（cubism2/3/4 的语音字段命名不一致，探测不可靠）。
  let _audioUnlocked = false
  let _engineInstance = null
  // "HH:MM" → 分钟数 的解析缓存（值域有限，避免 ticker 每轮重复正则）
  const _timeParseCache = new Map()
  // 待解锁后补播的自动动画目标：'welcome' | 'timemapping' | null
  // （仅记录“最近一个”即可；欢迎优先于时间映射）
  let _deferredAuto = null
  function unlockAudioOnce() {
    if (_audioUnlocked) return
    _audioUnlocked = true
    // 解锁后立刻补播加载期被推迟的自动动画（动作+语音一起出）
    const target = _deferredAuto
    _deferredAuto = null
    // 加载期因音频未解锁而被推迟的时间映射（IDLE 分支记录的），解锁后补播
    const pendingTimeMapping = _engineInstance && _engineInstance._timeMappingDeferred
    if ((target || pendingTimeMapping) && _engineInstance) {
      try {
        if (target === 'welcome') _engineInstance.playWelcomeFirstOpen()
        // 欢迎优先：即便时间映射也待播，欢迎被优先时由 _playWelcomeNow 结束后交回 IDLE 接管
        if (target === 'timemapping' || pendingTimeMapping) _engineInstance.checkTimeMappings()
      } catch (e) {}
    }
  }
  function installAudioUnlock() {
    const handler = () => {
      unlockAudioOnce()
      document.removeEventListener('pointerdown', handler, true)
      document.removeEventListener('keydown', handler, true)
      document.removeEventListener('touchstart', handler, true)
    }
    document.addEventListener('pointerdown', handler, true)
    document.addEventListener('keydown', handler, true)
    document.addEventListener('touchstart', handler, true)
  }

  // ══════════════════════════════════════════════════════════════════════
  //  CSS 注入
  // ══════════════════════════════════════════════════════════════════════

  const LIVE2D_CSS = [
    '#dsh-live2d-container {',
    '  position: fixed;',
    '  top: 330px;',
    '  left: 1240px;',
    '  bottom: auto;',
    '  z-index: 9999;',
    // 容器本身不拦截指针事件，画布区域点击完全穿透到页面，不影响输入；
    // 只有拖拽图标与画布大小手柄单独开启 pointer-events。
    '  pointer-events: none;',
    '  transition: none;',
    '  user-select: none;',
    '  -webkit-user-select: none;',
    // 触屏拖动必须禁用浏览器手势：否则 pointermove 会被滚动/缩放吃掉，
    // 拖到一半就断流（pointercancel）。
    '  touch-action: none;',
    '  -webkit-user-drag: none;',
    '}',
    '#dsh-live2d-container.dragging {',
    '  cursor: grabbing;',
    '  opacity: 0.9;',
    '}',
    '#dsh-live2d-container canvas {',
    '  display: block;',
    // 画布始终不拦截指针：鼠标滚轮/点击全部原生穿透给页面下层。
    // hit area 的命中检测在 document 捕获阶段完成（client.js 的
    // _setupCanvasInteraction），命中时触发 Tap 动画但不会消费事件。
    '  pointer-events: none;',
    // 模型未就绪前画布透明；就绪后由引擎 _fadeInCanvas 淡入显示
    // （CSS transition 使用先快后慢的贝塞尔曲线）
    '  opacity: 0;',
    '  transition: opacity 0.8s cubic-bezier(0.05, 0.9, 0.15, 1);',
    '}',
    '#dsh-live2d-container .dsh-live2d-label {',
    '  position: absolute;',
    '  bottom: -20px;',
    '  left: 50%;',
    '  transform: translateX(-50%);',
    '  font-size: 10px;',
    '  color: rgba(128,128,128,0.6);',
    '  white-space: nowrap;',
    '  pointer-events: none;',
    '  opacity: 0;',
    '  transition: opacity 0.3s;',
    '}',
    '#dsh-live2d-container:hover .dsh-live2d-label {',
    '  opacity: 1;',
    '}',
    // 控制浮层：固定定位，位置由 JS 动态计算——理想位置是画布右下角，
    // 但会被夹在视口内（画布拖出屏幕时，图标停在离画布右下角最近的屏幕边缘）。
    // 浮层本身不拦截指针（pointer-events:none），只有里面的图标可点。
    // 默认隐藏，仅当鼠标位于 Live2D 画布上方时才显示（由 JS 命中检测切换 .show，
    // 因为容器/canvas 为 pointer-events:none，CSS :hover 无法触发，且不能改动穿透逻辑）。
    '#dsh-live2d-controls {',
    '  position: fixed;',
    '  z-index: 10000;',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '  pointer-events: none;',
    '  opacity: 0;',
    '  transition: opacity 0.2s;',
    '}',
    // 鼠标位于画布上方时显示控制浮层
    '#dsh-live2d-controls.show {',
    '  opacity: 1;',
    '}',
    // 未显示时彻底禁用图标交互，避免透明状态下仍能误触
    '#dsh-live2d-controls:not(.show) .dsh-live2d-resize,',
    '#dsh-live2d-controls:not(.show) .dsh-live2d-drag {',
    '  pointer-events: none;',
    '}',
    // 画布大小拖拽手柄：常驻右下角浮层，与移动图标并排
    '#dsh-live2d-controls .dsh-live2d-resize {',
    '  width: 16px;',
    '  height: 16px;',
    '  border-right: 2px solid rgba(96,165,250,0.9);',
    '  border-bottom: 2px solid rgba(96,165,250,0.9);',
    '  cursor: nwse-resize;',
    '  opacity: 0.7;',
    '  pointer-events: auto;',
    '  flex: none;',
    '}',
    // 拖拽移动图标：常驻右下角浮层
    '#dsh-live2d-controls .dsh-live2d-drag {',
    '  width: 26px;',
    '  height: 26px;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  border-radius: 6px;',
    '  background: rgba(31,41,55,0.75);',
    '  color: rgba(226,232,240,0.95);',
    '  font-size: 15px;',
    '  line-height: 1;',
    '  cursor: grab;',
    '  user-select: none;',
    '  pointer-events: auto;',
    '  opacity: 0.85;',
    '  flex: none;',
    '}',
    '#dsh-live2d-controls .dsh-live2d-drag:active {',
    '  cursor: grabbing;',
    '}',
  ].join('\n')

  let cssInjected = false
  function injectCSS() {
    if (cssInjected) return
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-live2d'
    style.textContent = LIVE2D_CSS
    document.head.appendChild(style)
    cssInjected = true
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Live2D 引擎
  // ══════════════════════════════════════════════════════════════════════

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
      if (!this.model) return

      // 记录当前 DSH 状态（时间映射仅在空闲状态生效）
      this.currentStateName = stateName

      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (!modelEntry || !modelEntry.animations) return

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
        await this.triggerMotion(group, index, reason)
        return true
      }
      // 未解锁：记录目标，待解锁后补播（仅保留最近一个；欢迎优先于时间映射）
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
      if (!anim) return

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
      if (!this.model || !group) return
      try {
        const defs = this.model.internalModel.motionManager.definitions[group] || []
        if (defs.length === 0) return
        const index = Math.floor(Math.random() * defs.length)
        // 若处于循环状态且未指定具体 index，锁定本次随机到的 index
        if (this._loopState && this._loopState.index === null) this._loopState.index = index
        await this.triggerMotion(group, index, reason)
      } catch {}
    }

    async triggerMotion(group, index, reason) {
      if (!this.model) return
      // 强制切换掉正在播放的动画（含循环中的）
      this._stopCurrentMotion()
      try {
        await this.model.motion(group, index)
      } catch (e) {}
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

  // ══════════════════════════════════════════════════════════════════════
  //  拖动系统
  // ══════════════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════════════
  //  DSH 状态检测（轮询 host 端点）
  // ══════════════════════════════════════════════════════════════════════

  function useStateDetector() {
    const [dshState, setDshState] = useState(DSHState.IDLE)
    const pollTimerRef = useRef(null)

    useEffect(() => {
      // 优先使用 SSE 实时推送，状态一变更前端立即收到，消除动画触发延迟
      let es = null
      let fallbackTimer = null
      let closed = false

      const apply = (state) => { if (state) setDshState(state) }

      // 兜底：先立即拉一次，防止 SSE 连接前错过初始状态
      const bootstrap = async () => {
        try {
          const res = await fetch('/plugins/dsh-live2d/state', { cache: 'no-store' })
          if (res.ok) {
            const data = await res.json()
            if (data.state) setDshState(data.state)
          }
        } catch {}
      }
      bootstrap()

      try {
        es = new EventSource('/plugins/dsh-live2d/state/stream')
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data)
            if (data.state) apply(data.state)
          } catch {}
        }
        es.onerror = () => {
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

  // ══════════════════════════════════════════════════════════════════════
  //  主组件
  // ══════════════════════════════════════════════════════════════════════

  function Live2DWidget() {
    const containerRef = useRef(null)
    const dragHandleRef = useRef(null)
    const controlsRef = useRef(null)
    const engineRef = useRef(null)
    const cleanupDragRef = useRef(null)
    const lastStateRef = useRef(DSHState.IDLE)
    const dshState = useStateDetector()

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

    // 响应 DSH 状态变化，播放动画
    useEffect(() => {
      const engine = engineRef.current
      if (!engine || !engine.ready) return

      const prevState = lastStateRef.current
      const newState = dshState

      // 思考结束检测：THINKING → 非 THINKING = THINK_END
      if (prevState === DSHState.THINKING && newState !== DSHState.THINKING) {
        engine.playAnimation('THINK_END')
      }

      // 播放当前状态的动画
      if (newState !== prevState) {
        engine.playAnimation(newState)
      }

      lastStateRef.current = newState
    }, [dshState])

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

  // ══════════════════════════════════════════════════════════════════════
  //  设置页组件
  // ══════════════════════════════════════════════════════════════════════

  const cardStyle = {
    listStyle: 'none',
    border: '1px solid var(--border-color, #d8d8d8)',
    borderRadius: 12,
    padding: 16,
    background: 'var(--surface-color, transparent)',
    display: 'grid',
    gap: 14,
  }

  const rowStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 20,
  }

  const inputStyle = {
    padding: '6px 10px',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    border: '1px solid var(--border-color, #d8d8d8)',
    width: 80,
    textAlign: 'center',
  }

  function Field(props) {
    return h('label', { style: rowStyle },
      h('span', null,
        h('span', { style: { display: 'block', fontWeight: 600 } }, props.label),
        props.hint ? h('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, props.hint) : null,
      ),
      props.children,
    )
  }

  // 非安全上下文下的复制回退（Windows/macOS 通用）
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  function SettingsPage() {
    const [cfg, setCfg] = useState(function() {
      var c = getConfig()
      if (!c || !Array.isArray(c.models)) c = Object.assign({}, c || {}, { models: [] })
      return c
    })
    // 打开设置页时直接定位到当前正在显示的模型
    const [activeModel, setActiveModel] = useState(function() {
      return getActiveModelIndex(getConfig().models)
    })
    const [importStatus, setImportStatus] = useState('')
    const [scanning, setScanning] = useState(false)
    // 插件 assets 目录绝对路径（供用户复制，把模型文件夹放进去即可被自动扫描）
    const [assetsDir, setAssetsDir] = useState('')

    const updateModel = useCallback(function(modelIdx, patch) {
      setCfg(function(prev) {
        var models = (Array.isArray(prev.models) ? prev.models : []).slice()
        if (!models[modelIdx]) models[modelIdx] = {}
        models[modelIdx] = Object.assign({}, models[modelIdx], patch)
        return Object.assign({}, prev, { models: models })
      })
    }, [])

    const updateAnimation = useCallback(function(modelIdx, stateName, animConfig) {
      setCfg(function(prev) {
        var models = (Array.isArray(prev.models) ? prev.models : []).slice()
        if (!models[modelIdx]) models[modelIdx] = {}
        var model = Object.assign({}, models[modelIdx])
        var anims = Object.assign({}, model.animations || {})
        anims[stateName] = animConfig
        model.animations = anims
        models[modelIdx] = model
        return Object.assign({}, prev, { models: models })
      })
    }, [])

    // 修改动画映射：仅保存配置，不触发任何播放（避免编辑下拉框时误播一次被修改的动作）。
    // 真正的生效发生在下次状态切换 / 时间映射命中 / 首开时，无需即时预览。

    // 更新某条时间映射（时间段 + 动画配置）
    const updateTimeMapping = useCallback(function(modelIdx, tmIndex, patch) {
      setCfg(function(prev) {
        var models = (Array.isArray(prev.models) ? prev.models : []).slice()
        if (!models[modelIdx]) models[modelIdx] = {}
        var model = Object.assign({}, models[modelIdx])
        var tms = (Array.isArray(model.timeMappings) ? model.timeMappings : []).slice()
        if (!tms[tmIndex]) tms[tmIndex] = {}
        tms[tmIndex] = Object.assign({}, tms[tmIndex], patch)
        model.timeMappings = tms
        models[modelIdx] = model
        return Object.assign({}, prev, { models: models })
      })
    }, [])

    // 新增一条时间映射（默认 08:00–12:00，动作组留空）
    const addTimeMapping = useCallback(function(modelIdx) {
      setCfg(function(prev) {
        var models = (Array.isArray(prev.models) ? prev.models : []).slice()
        if (!models[modelIdx]) models[modelIdx] = {}
        var model = Object.assign({}, models[modelIdx])
        var tms = (Array.isArray(model.timeMappings) ? model.timeMappings : []).slice()
        tms.push({ start: '08:00', end: '12:00', animation: { motion: { group: '' } } })
        model.timeMappings = tms
        models[modelIdx] = model
        return Object.assign({}, prev, { models: models })
      })
    }, [])

    // 删除一条时间映射
    const removeTimeMapping = useCallback(function(modelIdx, tmIndex) {
      setCfg(function(prev) {
        var models = (Array.isArray(prev.models) ? prev.models : []).slice()
        if (!models[modelIdx]) return prev
        var model = Object.assign({}, models[modelIdx])
        var tms = (Array.isArray(model.timeMappings) ? model.timeMappings : []).slice()
        tms.splice(tmIndex, 1)
        model.timeMappings = tms
        models[modelIdx] = model
        return Object.assign({}, prev, { models: models })
      })
    }, [])

    // 从 model3.json 解析动作组/数量/动作名/表情（host 未提供时的兜底，无感刷新，无按钮）
    const enrichFromModel3 = function(url) {
      if (!url) return Promise.resolve(null)
      return fetch(url)
        .then(function(r) { return r.ok ? r.json() : null })
        .then(function(model3) {
          if (!model3) return null
          var fr = model3.FileReferences || {}
          var motions = fr.Motions || {}
          var groups = Object.keys(motions)
          var groupCounts = {}
          var groupMotions = {}
          groups.forEach(function(g) {
            var entries = Array.isArray(motions[g]) ? motions[g] : []
            groupCounts[g] = entries.length
            groupMotions[g] = entries.map(function(mo) {
              var f = (typeof mo === 'string' ? mo : (mo.File || mo.file || ''))
              return f.split('/').pop().replace(/\.motion3\.json$/i, '').replace(/\.motion3$/i, '')
            })
          })
          var expressions = (fr.Expressions || []).map(function(x) {
            return typeof x === 'string'
              ? x.split('/').pop().replace(/\.exp3\.json$/i, '')
              : (x.Name || (x.File || '')).toString()
          })
          return { groups: groups, groupCounts: groupCounts, groupMotions: groupMotions, expressions: expressions }
        })
        .catch(function() { return null })
    }

    // 扫描插件 assets 目录下所有含 .model3.json 的子文件夹，自动生成模型列表。
    // host 端已一并解析好每个模型的动作组与表情，前端只需展示与保存动画映射。
    // 用户之前配置过的动画（animations）按模型名保留，避免刷新扫描后丢失。
    const scanModels = useCallback(function() {
      setScanning(true)
      setImportStatus('正在扫描模型目录…')
      fetch('/plugins/dsh-live2d/models')
        .then(function(r) {
          if (!r.ok) throw new Error('扫描失败 ' + r.status)
          return r.json()
        })
        .then(function(data) {
          if (data.assetsDir) setAssetsDir(data.assetsDir)
          setCfg(function(prev) {
            var existingByName = {}
            ;(Array.isArray(prev.models) ? prev.models : []).forEach(function(m) { if (m.name) existingByName[m.name] = m })
            var merged = (data.models || []).map(function(h) {
              var ex = existingByName[h.name] || {}
              return {
                name: h.name,
                url: h.url,
                canvasWidth: ex.canvasWidth || 300,
                canvasHeight: ex.canvasHeight || 400,
                config: ex.config || { x: 0, y: 0, scaleX: 1, scaleY: 1 },
                // 动作组/表情来自 host 扫描结果（自动读取，无需按钮）
                groups: Array.isArray(h.groups) ? h.groups : [],
                groupCounts: (h.groupCounts && typeof h.groupCounts === 'object') ? h.groupCounts : {},
                groupMotions: (h.groupMotions && typeof h.groupMotions === 'object') ? h.groupMotions : {},
                expressions: Array.isArray(h.expressions) ? h.expressions : [],
                // 动画映射：合并用户已有配置与内置默认映射——用户缺失的状态（如新增的 SPEAKING）自动补全，用户已有的仍优先
                animations: Object.assign({}, h.animations || {}, ex.animations || {}),
                // 时间映射：保留用户已配置的时间段映射（重新扫描不丢失）
                timeMappings: Array.isArray(ex.timeMappings) ? ex.timeMappings : [],
              }
            })
            var next = Object.assign({}, prev, { models: merged })
            return next
          })
          // 兜底：若 host 未返回 groupMotions（旧版接口/缓存），自行拉取 model3.json 补全
          ;(data.models || []).forEach(function(h) {
            if (h.groupMotions && Object.keys(h.groupMotions).length) return
            enrichFromModel3(h.url).then(function(meta) {
              if (!meta) return
              setCfg(function(prev) {
                var prevModels = Array.isArray(prev.models) ? prev.models : []
                var models = prevModels.map(function(m) {
                  if (m.name !== h.name) return m
                  return Object.assign({}, m, {
                    groups: meta.groups, groupCounts: meta.groupCounts,
                    groupMotions: meta.groupMotions, expressions: meta.expressions,
                  })
                })
                return Object.assign({}, prev, { models: models })
              })
            })
          })
          setImportStatus('扫描完成：' + (data.models || []).length + ' 个模型')
          setTimeout(function() { setImportStatus('') }, 3000)
        })
        .catch(function(err) {
          setImportStatus('扫描失败：' + (err && err.message ? err.message : err))
          setTimeout(function() { setImportStatus('') }, 4000)
        })
        .finally(function() { setScanning(false) })
    }, [])

    // 组件挂载时自动扫描一次
    useEffect(function() { scanModels() }, [scanModels])

    // 配置变化后统一持久化（debounced）：把副作用移出 setCfg 更新函数，
    // 避免 React 严格模式下更新函数被重复调用时重复写入，也保证引擎侧读到的
    // 内存缓存（_configCache）与设置页状态一致。
    useEffect(function() { saveConfig(cfg) }, [cfg])

    var safeModels = Array.isArray(cfg.models) ? cfg.models : []
    var currentModelRaw = safeModels[activeModel] || safeModels[0] || {}
    // 保证动画映射所需字段存在（兼容扫描前的旧配置 / 尚未扫描时的占位条目）
    var currentModel = Object.assign(
      { name: '', url: '', canvasWidth: 300, canvasHeight: 400, config: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, animations: {}, timeMappings: [] },
      currentModelRaw,
      { groups: Array.isArray(currentModelRaw.groups) ? currentModelRaw.groups : [], groupCounts: (currentModelRaw.groupCounts && typeof currentModelRaw.groupCounts === 'object') ? currentModelRaw.groupCounts : {}, groupMotions: (currentModelRaw.groupMotions && typeof currentModelRaw.groupMotions === 'object') ? currentModelRaw.groupMotions : {}, expressions: Array.isArray(currentModelRaw.expressions) ? currentModelRaw.expressions : [], timeMappings: Array.isArray(currentModelRaw.timeMappings) ? currentModelRaw.timeMappings : [] }
    )


    return h('div', { style: { padding: '6px 10px 20px', fontSize: 13, lineHeight: 1.6 } },

      // ── 通用设置 ──────────────────────────────────────────
      h('div', { style: Object.assign({}, cardStyle, { marginBottom: 16 }) },
        h('strong', { style: { fontSize: 14 } }, '通用设置'),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: !!getConfig().eyeFollow,
            onChange: function(e) {
              var enabled = e.target.checked
              // 立即同步到引擎，并更新 React 状态让受控复选框即时刷新
              // （持久化由下方 useEffect([cfg]) 统一处理）
              if (window.__dshLive2DEngineSetEyeFollow) window.__dshLive2DEngineSetEyeFollow(enabled)
              setCfg(function(prev) {
                return Object.assign({}, prev, { eyeFollow: enabled })
              })
            },
          }),
          '眼睛跟随鼠标（模型视线随光标移动）',
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: !!getConfig().hitArea,
            onChange: function(e) {
              var enabled = e.target.checked
              // 立即同步到引擎，并更新 React 状态让受控复选框即时刷新
              // （持久化由下方 useEffect([cfg]) 统一处理）
              if (window.__dshLive2DEngineSetHitArea) window.__dshLive2DEngineSetHitArea(enabled)
              setCfg(function(prev) {
                return Object.assign({}, prev, { hitArea: enabled })
              })
            },
          }),
          '点击命中区域（点击模型 HitArea 触发 Tap 动画；关闭后点击完全穿透）',
        ),
      ),

      // ── 模型目录 ──────────────────────────────────────────
      h('div', { style: Object.assign({}, cardStyle, { marginBottom: 16 }) },
        h('strong', { style: { fontSize: 14 } }, '模型目录'),
        h('p', { style: { margin: '4px 0 8px', opacity: 0.65, fontSize: 12 } },
          '把模型文件夹（须含 .model3.json）放进下面的 assets 目录，点击「刷新模型列表」即可自动加入。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            onClick: function() {
              var path = assetsDir || ''
              if (!path) {
                setImportStatus('目录路径：(未知)')
                setTimeout(function() { setImportStatus('') }, 4000)
                return
              }
              // Windows / macOS 通用复制：优先 Clipboard API，非安全上下文回退 execCommand
              var done = function() { setImportStatus('已复制目录路径：' + path) }
              var fail = function() { setImportStatus('复制失败，路径：' + path) }
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(path).then(done, function() { legacyCopy(path) ? done() : fail() })
              } else {
                legacyCopy(path) ? done() : fail()
              }
              setTimeout(function() { setImportStatus('') }, 4000)
            },
            style: { padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
          }, '复制 assets 目录路径'),
          h('button', {
            onClick: scanModels,
            disabled: scanning,
            style: { padding: '6px 16px', borderRadius: 8, border: '1px solid #60a5fa', background: 'rgba(96,165,250,0.15)', color: 'inherit', cursor: scanning ? 'default' : 'pointer', whiteSpace: 'nowrap' },
          }, scanning ? '扫描中…' : '刷新模型列表'),
          // 模型扫描/操作提示：显示在「刷新模型列表」按钮右侧
          importStatus ? h('span', { style: { color: /扫描完成|已复制|已添加|成功/.test(importStatus) ? '#4ade80' : '#f87171', fontSize: 12, whiteSpace: 'nowrap' } }, importStatus) : null,
        ),
      ),

      // ── 模型列表 ──────────────────────────────────────────
      h('div', { style: cardStyle },
        h('strong', { style: { fontSize: 14 } }, '模型列表'),

        // 模型选择标签（点击即切换为当前显示模型，并打开该模型的配置页）
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
          safeModels.map(function(m, i) {
            return h('button', {
              key: i,
              onClick: function() {
                setActiveModel(i)
                if (window.__dshLive2DEngineSwitch) window.__dshLive2DEngineSwitch(i)
              },
              style: {
                padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: i === activeModel ? '2px solid #60a5fa' : '1px solid var(--border-color, #d8d8d8)',
                background: i === activeModel ? 'rgba(96,165,250,0.15)' : 'transparent',
                color: 'inherit',
              },
            },
              m.name || ('Model ' + i)
            )
          })
        ),

        // 当前模型编辑
        currentModel ? h('div', { style: { display: 'grid', gap: 10, marginTop: 8 } },
          // 模型路径：自动识别，作为辨认标识
          h('div', { style: { fontSize: 12, opacity: 0.65 } },
            h('span', { style: { opacity: 0.5 } }, '模型路径：'),
            h('span', { style: { opacity: 0.85 }, title: currentModel.url || '' }, currentModel.url || '(未识别)'),
          ),
          h(Field, { label: '模型名称', hint: '显示名称（可自定义）' },
            h('input', {
              type: 'text', value: currentModel.name || '',
              onChange: function(e) { updateModel(activeModel, { name: e.target.value }) },
              style: Object.assign({}, inputStyle, { width: 150 }),
            }),
          ),
        ) : null,
      ),

      // ── 动画映射 ──────────────────────────────────────────
      currentModel ? h('div', { style: Object.assign({}, cardStyle, { marginTop: 16 }) },
        h('strong', { style: { fontSize: 14 } }, '动画映射'),
        h('p', { style: { margin: '4px 0 8px', opacity: 0.65, fontSize: 12 } },
          '为每个 DSH 状态选择动作组与（可选）组内序号；不填序号则随机播放该组动作。也可选择表情。'),
        // 列标题行：结构与下方每行完全一致（rowStyle: space-between + gap:20），
        // 动作组前留半个制表符距离（16px），右对齐，确保与下拉列对齐
        h('div', { style: Object.assign({}, rowStyle, { marginBottom: 4, opacity: 0.55, fontSize: 11 }) },
          h('span', { style: { minWidth: 80 } }, '状态'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8 } },
            h('span', { style: { width: 110, textAlign: 'right' } }, '动作组'),
            h('span', { style: { width: 70, textAlign: 'right' } }, '动作'),
            h('span', { style: { width: 100, textAlign: 'right' } }, '表情'),
            h('span', { style: { width: 52, textAlign: 'right' } }, '循环'),
          ),
        ),
        ANIMATION_STATES.map(function(stateName) {
          var anim = (currentModel.animations || {})[stateName] || {}
          var selGroup = anim.motion ? (anim.motion.group || '') : ''
          var selIndex = (anim.motion && typeof anim.motion.index === 'number') ? String(anim.motion.index) : ''
          var selExpr = anim.expression || ''

          // 当前选中组的动作选项：显示每个 motion 的文件名（去扩展名，如 idle）
          var motionNames = (currentModel.groupMotions && Array.isArray(currentModel.groupMotions[selGroup])) ? currentModel.groupMotions[selGroup] : []
          var idxCount = motionNames.length || (currentModel.groupCounts ? (currentModel.groupCounts[selGroup] || 0) : 0)

          function applyMotion(nextGroup, nextIndex, loop) {
            var next = {}
            if (nextGroup) {
              next.motion = { group: nextGroup }
              if (nextIndex !== '' && nextIndex !== null && nextIndex !== undefined) {
                next.motion.index = parseInt(nextIndex, 10) || 0
              }
            }
            if (selExpr) next.expression = selExpr
            if (loop === true || loop === false) next.loop = loop
            else if (anim.loop) next.loop = anim.loop
            if (!nextGroup && !next.motion && !selExpr && !next.loop) next = {}
            updateAnimation(activeModel, stateName, next)
          }

          return h('div', { key: stateName, style: Object.assign({}, rowStyle, { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' }) },
            h('span', { style: { fontWeight: 600, minWidth: 80, fontSize: 12 } },
              (ANIMATION_STATE_LABELS[stateName] || stateName),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginLeft: 8 } },
              // 动作组下拉
              h('select', {
                value: selGroup,
                onChange: function(e) {
                  var g = e.target.value
                  // 切换组时清空序号（改为整组随机），保留循环开关
                  applyMotion(g, '', anim.loop)
                },
                style: Object.assign({}, inputStyle, { width: 110, fontSize: 11 }),
              },
                h('option', { value: '' }, '空'),
                currentModel.groups.map(function(g) {
                  return h('option', { key: g, value: g }, g)
                }),
              ),
              // 组内动作下拉：显示每个 motion 的文件名（如 idle），默认空 = 随机整组
              h('select', {
                value: selIndex,
                disabled: !selGroup,
                onChange: function(e) {
                  applyMotion(selGroup, e.target.value, anim.loop)
                },
                style: Object.assign({}, inputStyle, { width: 70, fontSize: 11 }),
              },
                h('option', { value: '' }, '随机'),
                motionNames.map(function(name, i) {
                  return h('option', { key: i, value: String(i) }, name)
                }),
              ),
              // 表情下拉
              h('select', {
                value: selExpr,
                onChange: function(e) {
                  var val = e.target.value
                  var loop = anim.loop === true
                  if (val) {
                    updateAnimation(activeModel, stateName, selGroup ? { motion: { group: selGroup }, expression: val, loop: loop } : { expression: val, loop: loop })
                  } else {
                    updateAnimation(activeModel, stateName, selGroup ? { motion: { group: selGroup }, loop: loop } : { loop: loop })
                  }
                },
                style: Object.assign({}, inputStyle, { width: 100, fontSize: 11 }),
              },
                h('option', { value: '' }, '空'),
                currentModel.expressions.map(function(ex) {
                  return h('option', { key: ex, value: ex }, ex)
                }),
              ),
              // 循环播放开关：打开后该状态动画持续循环，直到切换到其他状态
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }, title: '循环播放：开启后持续播放该动作，直到切换到其他状态' },
                h('input', {
                  type: 'checkbox',
                  checked: anim.loop === true,
                  onChange: function(e) {
                    var loop = e.target.checked
                    var next = {}
                    if (selGroup) next.motion = anim.motion ? Object.assign({}, anim.motion) : { group: selGroup }
                    if (selExpr) next.expression = selExpr
                    next.loop = loop
                    updateAnimation(activeModel, stateName, next)
                  },
                }),
                '循环',
              ),
            ),
          )
        }),

        // ── 时间映射：满足时间段条件时触发对应动画 ──────────────────────
        h('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(127,127,127,0.2)' } },
          h('div', { style: Object.assign({}, rowStyle, { marginBottom: 6 }) },
            h('strong', { style: { fontSize: 13 } }, '时间映射'),
            h('button', {
              onClick: function() { addTimeMapping(activeModel) },
              style: { padding: '3px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid #60a5fa', background: 'rgba(96,165,250,0.15)', color: 'inherit', whiteSpace: 'nowrap' },
            }, '+ 添加时间段'),
          ),
          h('p', { style: { margin: '0 0 8px', opacity: 0.65, fontSize: 12 } },
            '设置时间段与动画：当前时间落在时间段内且模型处于空闲状态时播放对应动画，离开时间段自动恢复空闲动画。支持跨午夜（如 22:00–06:00）。'),
          (Array.isArray(currentModel.timeMappings) && currentModel.timeMappings.length ? currentModel.timeMappings : []).map(function(tm, ti) {
            var tAnim = (tm && tm.animation) || {}
            var tGroup = tAnim.motion ? (tAnim.motion.group || '') : ''
            var tIndex = (tAnim.motion && typeof tAnim.motion.index === 'number') ? String(tAnim.motion.index) : ''
            var tExpr = tAnim.expression || ''
            var tMotionNames = (currentModel.groupMotions && Array.isArray(currentModel.groupMotions[tGroup])) ? currentModel.groupMotions[tGroup] : []

            function applyTimeAnim(next) {
              updateTimeMapping(activeModel, ti, { animation: next })
            }

            return h('div', { key: 'tm' + ti, style: Object.assign({}, rowStyle, { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.15)', flexWrap: 'wrap', gap: 6 }) },
              // 时间段：开始/结束时间上下排列
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                h('input', {
                  type: 'time',
                  value: tm && tm.start ? tm.start : '08:00',
                  onChange: function(e) { updateTimeMapping(activeModel, ti, { start: e.target.value }) },
                  title: '开始时间（HH:MM）',
                  style: Object.assign({}, inputStyle, { width: 88, fontSize: 11 }),
                }),
                h('input', {
                  type: 'time',
                  value: tm && tm.end ? tm.end : '12:00',
                  onChange: function(e) { updateTimeMapping(activeModel, ti, { end: e.target.value }) },
                  title: '结束时间（HH:MM）',
                  style: Object.assign({}, inputStyle, { width: 88, fontSize: 11 }),
                }),
              ),
              // 动作组下拉
              h('select', {
                value: tGroup,
                onChange: function(e) {
                  var g = e.target.value
                  var next = {}
                  if (g) next.motion = { group: g }
                  if (tExpr) next.expression = tExpr
                  if (tAnim.loop) next.loop = true
                  applyTimeAnim(next)
                },
                title: '动作组',
                style: Object.assign({}, inputStyle, { width: 100, fontSize: 11 }),
              },
                h('option', { value: '' }, '空'),
                currentModel.groups.map(function(g) {
                  return h('option', { key: g, value: g }, g)
                }),
              ),
              // 组内动作下拉
              h('select', {
                value: tIndex,
                disabled: !tGroup,
                onChange: function(e) {
                  var val = e.target.value
                  var next = {}
                  if (tGroup) {
                    next.motion = { group: tGroup }
                    if (val !== '') next.motion.index = parseInt(val, 10) || 0
                  }
                  if (tExpr) next.expression = tExpr
                  if (tAnim.loop) next.loop = true
                  applyTimeAnim(next)
                },
                title: '组内动作（空 = 随机整组）',
                style: Object.assign({}, inputStyle, { width: 64, fontSize: 11 }),
              },
                h('option', { value: '' }, '随机'),
                tMotionNames.map(function(name, i) {
                  return h('option', { key: i, value: String(i) }, name)
                }),
              ),
              // 表情下拉
              h('select', {
                value: tExpr,
                onChange: function(e) {
                  var val = e.target.value
                  var next = {}
                  if (tGroup) next.motion = tAnim.motion ? Object.assign({}, tAnim.motion) : { group: tGroup }
                  if (val) next.expression = val
                  if (tAnim.loop) next.loop = true
                  applyTimeAnim(next)
                },
                title: '表情',
                style: Object.assign({}, inputStyle, { width: 88, fontSize: 11 }),
              },
                h('option', { value: '' }, '空'),
                currentModel.expressions.map(function(ex) {
                  return h('option', { key: ex, value: ex }, ex)
                }),
              ),
              // 循环开关
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }, title: '循环播放：时间段内持续循环该动作' },
                h('input', {
                  type: 'checkbox',
                  checked: tAnim.loop === true,
                  onChange: function(e) {
                    var next = {}
                    if (tGroup) next.motion = tAnim.motion ? Object.assign({}, tAnim.motion) : { group: tGroup }
                    if (tExpr) next.expression = tExpr
                    next.loop = e.target.checked
                    applyTimeAnim(next)
                  },
                }),
                '循环',
              ),
              // 删除按钮
              h('button', {
                onClick: function() { removeTimeMapping(activeModel, ti) },
                title: '删除该时间段',
                style: { padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid rgba(248,113,113,0.5)', background: 'transparent', color: 'inherit', whiteSpace: 'nowrap' },
              }, '删除'),
            )
          }),
        ),
      ) : null,
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  //  插件入口
  // ══════════════════════════════════════════════════════════════════════

  function apply(ctx) {
    injectCSS()

    // 注入 shell.overlay：渲染 Live2D 模型
    // slots.inject 的回调必须 RETURN register 返回的 disposer：
    // 它是通过 ctx.effect 安装的，不返回就等于丢弃注销函数，
    // 插件卸载 / HMR 时槽位条目不会被移除（重复堆叠 + 泄漏）。
    try {
      ctx.slots.inject('shell.overlay', function() {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-live2d',
          order: 99,
          label: function() { return 'Live2D' },
        }, function() { return h(Live2DWidget) })
      })
    } catch (err) {
      console.error('[dsh-live2d] Failed to inject shell.overlay:', err)
    }

    // 注入设置页
    try {
      ctx.slots.inject('settings.section', function() {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-live2d',
          order: 40,
          label: function() { return 'Live2D 看板娘' },
        }, function() { return h(SettingsPage) })
      })
    } catch (err) {
      console.error('[dsh-live2d] Failed to inject settings.section:', err)
    }
  }

  module.exports = {
    name: 'dsh-live2d-client',
    inject: ['slots'],
    apply: apply,
  }
  return module.exports
} })
