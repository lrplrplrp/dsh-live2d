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

window.__ModuleLoader__.load({ id: 'dsh-live2d', factory: (require) => {
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

  // 本地文件路由前缀（由 host 端 index.js 注册）
  const LIB_BASE = '/plugins/dsh-live2d/lib/'
  const ASSETS_BASE = '/plugins/dsh-live2d/assets/'

  // 配置 / 上传接口（与 host 端 index.js 中的 CONFIG_ENDPOINT 对应）
  const CONFIG_ENDPOINT = '/plugins/dsh-live2d/config'

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

  const ANIMATION_STATES =['IDLE', 'THINKING', 'THINK_END', 'WORKING', 'SPEAKING', 'SUCCESS', 'ERROR']

  const ANIMATION_STATE_LABELS = {
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
      config: { x: -50, y: 100, scaleX: 2, scaleY: 2 },
      animations: {
        IDLE: { motion: { group: 'Idle', index: 0 }, loop: false },
        THINKING: { motion: { group: 'Anima', index: 2 }, loop: false },
        THINK_END: { motion: { group: 'Anima', index: 1 }, loop: false },
        WORKING: { motion: { group: 'Anima', index: 0 }, loop: false },
        SPEAKING: { motion: { group: 'Anima', index: 0 }, loop: false },
        SUCCESS: { expression: 'happy' },
        ERROR: { expression: 'unhappy' },
      },
    }],
    // 眼睛是否跟随鼠标（全局开关）
    eyeFollow: true,
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
      if (!m || typeof m !== 'object') return { name: '', url: '', groups: [], groupCounts: {}, groupMotions: {}, expressions: [], animations: {} }
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
      }
    })
    return Object.assign({}, cfg, { models: models, eyeFollow: cfg.eyeFollow === false ? false : true })
  }

  function getConfig() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_MODEL_LIST)))
      const stored = JSON.parse(raw)
      return normalizeConfig(stored)
    } catch {
      return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_MODEL_LIST)))
    }
  }

  function saveConfig(cfg) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
    } catch {}
  }

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

  // ══════════════════════════════════════════════════════════════════════
  //  CSS 注入
  // ══════════════════════════════════════════════════════════════════════

  const LIVE2D_CSS = [
    '#dsh-live2d-container {',
    '  position: fixed;',
    '  bottom: 0;',
    '  left: 0;',
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
    // 模型本体的 HitAreas 为空（deepseek.model3.json: "HitAreas": []），
    // canvas 不需要接收指针事件；交给容器统一处理，拖动才能从画布上起手。
    '  pointer-events: none;',
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
    // 画布大小拖拽手柄：平时隐藏，鼠标悬停画布（容器）时在右下角出现，与移动图标重叠
    '#dsh-live2d-container .dsh-live2d-resize {',
    '  position: absolute;',
    '  right: 4px;',
    '  bottom: 4px;',
    '  width: 14px;',
    '  height: 14px;',
    '  border-right: 2px solid rgba(96,165,250,0.9);',
    '  border-bottom: 2px solid rgba(96,165,250,0.9);',
    '  cursor: nwse-resize;',
    '  opacity: 0;',
    '  transition: opacity 0.2s;',
    '  pointer-events: auto;',
    '  z-index: 1;',
    '}',
    '#dsh-live2d-container.hovering .dsh-live2d-resize {',
    '  opacity: 0.9;',
    '}',
    // 拖拽移动图标：平时隐藏，鼠标悬停画布（容器）时出现，与画布大小手柄重叠显示在上方
    '#dsh-live2d-container .dsh-live2d-drag {',
    '  position: absolute;',
    '  right: 9px;',
    '  bottom: 9px;',
    '  width: 22px;',
    '  height: 22px;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  border-radius: 6px;',
    '  background: rgba(31,41,55,0.65);',
    '  color: rgba(226,232,240,0.9);',
    '  font-size: 14px;',
    '  line-height: 1;',
    '  cursor: grab;',
    '  user-select: none;',
    '  pointer-events: auto;',
    '  opacity: 0;',
    '  transition: opacity 0.2s;',
    '  z-index: 2;',
    '}',
    '#dsh-live2d-container.hovering .dsh-live2d-drag {',
    '  opacity: 0.9;',
    '}',
    '#dsh-live2d-container.dragging .dsh-live2d-drag {',
    '  cursor: grabbing;',
    '  opacity: 0.9;',
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
      // 循环播放状态：{ group, index } 或 null；motionFinish 时若仍为该状态则重启
      this._loopState = null
      this._loopCooldown = 0
    }

    async     init(containerEl) {
      this.container = containerEl

      // 从全局配置读取眼睛跟随开关初始值
      try { this.eyeFollow = getConfig().eyeFollow !== false } catch {}
      if (this.eyeFollow === undefined) this.eyeFollow = true

      const ok = await ensureLibsLoaded()
      if (!ok) return false

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

        // 自动调整大小和位置
        this.autoSetTransform(modelEntry)

        // 绑定点击区域
        this.drawHitArea()

        // 模型切换后清除循环状态，避免对不存在的 group/动作重启
        this._loopState = null

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
        if (Object.keys(model.internalModel.hitAreas).length > 0) {
          model.on('hit', (hitarea) => {
            this.triggerMotion('Tap' + hitarea)
          })
        }
      } catch {}
    }

    // ── 动画控制 ──────────────────────────────────────────────────────

    async playAnimation(stateName) {
      if (!this.model) return

      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      if (!modelEntry || !modelEntry.animations) return

      const anim = modelEntry.animations[stateName]
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
          await this.triggerMotion(anim.motion.group, anim.motion.index)
        } else {
          await this.triggerMotionGroup(anim.motion.group)
        }
      }
      if (anim.expression) {
        this.triggerExpression(anim.expression)
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
    async triggerMotionGroup(group) {
      if (!this.model || !group) return
      try {
        const defs = this.model.internalModel.motionManager.definitions[group] || []
        if (defs.length === 0) return
        const index = Math.floor(Math.random() * defs.length)
        // 若处于循环状态且未指定具体 index，锁定本次随机到的 index
        if (this._loopState && this._loopState.index === null) this._loopState.index = index
        await this.triggerMotion(group, index)
      } catch {}
    }

    async triggerMotion(group, index) {
      if (!this.model) return
      // 强制切换掉正在播放的动画（含循环中的）
      this._stopCurrentMotion()
      try {
        await this.model.motion(group, index)
      } catch {}
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
      this.playAnimation('IDLE')
    }

    getCurrentScale() {
      const modelList = getConfig()
      const modelEntry = modelList.models[this.currentModelIndex]
      return modelEntry && modelEntry.config ? modelEntry.config.scaleX || 1 : 1
    }

    destroy() {
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
  }

  // ══════════════════════════════════════════════════════════════════════
  //  拖动系统
  // ══════════════════════════════════════════════════════════════════════

  // 超过这个像素位移才算拖动（避免手抖把点击误判成拖动）
  const DRAG_THRESHOLD = 4

  /**
   * 把归一化位置写回容器。
   * `bottom` 必须置为 auto，否则 left/top 与 bottom 同时生效时浏览器
   * 会优先满足 bottom，拖动看起来"完全没反应"。
   */
  function place(containerEl, x, y) {
    // 容器是 position:fixed，left/top 相对视口；因此钳制也必须用视口尺寸，
    // 不能用 offsetWidth/offsetHeight（offsetParent 是 overlay 层，原点未必是视口 0,0）。
    const rect = containerEl.getBoundingClientRect()
    const maxX = Math.max(0, window.innerWidth - rect.width)
    const maxY = Math.max(0, window.innerHeight - rect.height)
    containerEl.style.left = Math.min(Math.max(x, 0), maxX) + 'px'
    containerEl.style.top = Math.min(Math.max(y, 0), maxY) + 'px'
    containerEl.style.bottom = 'auto'
  }

  function setupDrag(handleEl, containerEl) {
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
    }

    const finish = () => {
      if (pointerId !== null) {
        try { handleEl.releasePointerCapture(pointerId) } catch {}
      }
      if (dragging) containerEl.classList.remove('dragging')
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
      // 捕获指针：拖出容器甚至拖出窗口也不断流
      try { handleEl.setPointerCapture(pointerId) } catch {}
    }

    const onPointerMove = (e) => {
      if (!dragging) return
      if (e.pointerId !== pointerId) return

      curX = origX + (e.clientX - startX)
      curY = origY + (e.clientY - startY)
      place(containerEl, curX, curY)
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

      engine.init(containerRef.current).then((ok) => {
        if (ok) {
          engine.playAnimation('IDLE')
        }
      })

      cleanupDragRef.current = setupDrag(dragHandleRef.current, containerRef.current)

      // 悬停探测：容器 pointer-events:none 导致 CSS :hover 只在子元素上触发，
      // 这里用 window 级 mousemove 判断指针是否落在画布矩形内，动态切换 hovering 类，
      // 实现"鼠标在画布上时显示两个手柄"，同时画布本身不拦截输入。
      const onMouseMove = (e) => {
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        if (inside) el.classList.add('hovering')
        else el.classList.remove('hovering')
      }
      window.addEventListener('mousemove', onMouseMove)

      return () => {
        cleanupDragRef.current?.()
        window.removeEventListener('mousemove', onMouseMove)
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
      const rect = containerEl.getBoundingClientRect()
      const startW = rect.width
      const startH = rect.height
      const pointerId = e.pointerId

      try { e.target.setPointerCapture(pointerId) } catch {}

      const move = (ev) => {
        if (ev.pointerId !== pointerId) return
        const dw = ev.clientX - startX
        const dh = ev.clientY - startY
        const w = Math.min(800, Math.max(100, startW + dw))
        const h = Math.min(800, Math.max(100, startH + dh))
        engine.setCanvasSize(w, h)
      }
      const up = (ev) => {
        if (ev.pointerId !== pointerId) return
        try { e.target.releasePointerCapture(pointerId) } catch {}
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    }, [])

    return h('div', {
      ref: containerRef,
      id: 'dsh-live2d-container',
      onWheel: onWheel,
    },
      // 右下角拖拽移动图标：只有拖动它才能移动整个看板娘，画布本身不再拦截输入
      h('div', {
        ref: dragHandleRef,
        className: 'dsh-live2d-drag',
        title: '拖动移动看板娘；鼠标滚轮缩放模型大小',
      }, '✥'),
      // 画布大小手柄：仅鼠标悬停画布（容器）时显示
      h('div', {
        className: 'dsh-live2d-resize',
        title: '拖动改变画布大小',
        onPointerDown: onResizePointerDown,
      }),
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
        var next = Object.assign({}, prev, { models: models })
        saveConfig(next)
        return next
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
        var next = Object.assign({}, prev, { models: models })
        saveConfig(next)
        return next
      })
    }, [])

    // 修改动画映射时同步强制切换掉正在播放的动画（若修改的是当前激活模型）
    const updateAnimationWithForceSwitch = useCallback(function(modelIdx, stateName, animConfig) {
      updateAnimation(modelIdx, stateName, animConfig)
      if (modelIdx === activeModel && window.__dshLive2DEngineForceSwitch) {
        window.__dshLive2DEngineForceSwitch(stateName)
      }
    }, [activeModel, updateAnimation])

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
              }
            })
            var next = Object.assign({}, prev, { models: merged })
            saveConfig(next)
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
                  var merged2 = Object.assign({}, m, {
                    groups: meta.groups, groupCounts: meta.groupCounts,
                    groupMotions: meta.groupMotions, expressions: meta.expressions,
                  })
                  var next2 = Object.assign({}, prev, { models: models.map(function(x) { return x === m ? merged2 : x }) })
                  return next2
                })
                if (models === prevModels) return prev
                saveConfig(Object.assign({}, prev, { models: models }))
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

    var safeModels = Array.isArray(cfg.models) ? cfg.models : []
    var currentModelRaw = safeModels[activeModel] || safeModels[0] || {}
    // 保证动画映射所需字段存在（兼容扫描前的旧配置 / 尚未扫描时的占位条目）
    var currentModel = Object.assign(
      { name: '', url: '', canvasWidth: 300, canvasHeight: 400, config: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, animations: {} },
      currentModelRaw,
      { groups: Array.isArray(currentModelRaw.groups) ? currentModelRaw.groups : [], groupCounts: (currentModelRaw.groupCounts && typeof currentModelRaw.groupCounts === 'object') ? currentModelRaw.groupCounts : {}, groupMotions: (currentModelRaw.groupMotions && typeof currentModelRaw.groupMotions === 'object') ? currentModelRaw.groupMotions : {}, expressions: Array.isArray(currentModelRaw.expressions) ? currentModelRaw.expressions : [] }
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
              // 立即同步到引擎并持久化，同时更新 React 状态让受控复选框即时刷新
              if (window.__dshLive2DEngineSetEyeFollow) window.__dshLive2DEngineSetEyeFollow(enabled)
              setCfg(function(prev) {
                var next = Object.assign({}, prev, { eyeFollow: enabled })
                saveConfig(next)
                return next
              })
            },
          }),
          '眼睛跟随鼠标（模型视线随光标移动）',
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
        ),
        importStatus ? h('p', { style: { margin: '6px 0 0', color: /扫描完成|已复制|已添加|成功/.test(importStatus) ? '#4ade80' : '#f87171', fontSize: 12 } }, importStatus) : null,
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
            updateAnimationWithForceSwitch(activeModel, stateName, next)
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
                    updateAnimationWithForceSwitch(activeModel, stateName, selGroup ? { motion: { group: selGroup }, expression: val, loop: loop } : { expression: val, loop: loop })
                  } else {
                    updateAnimationWithForceSwitch(activeModel, stateName, selGroup ? { motion: { group: selGroup }, loop: loop } : { loop: loop })
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
                    updateAnimationWithForceSwitch(activeModel, stateName, next)
                  },
                }),
                '循环',
              ),
            ),
          )
        }),
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
