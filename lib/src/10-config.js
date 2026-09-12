  // ══════════════════════════════════════════════════════════════════════
  //  常量 & 配置
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：常量、默认模型列表、localStorage 配置读写与内存缓存（+ 构建时内联的共享 DSHState））

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

  // DSHState 由 lib/shared/states.js 内联提供（host 与 client 的单一来源），
  // 见 scripts/build-client.mjs —— 此处不再重复定义。

  // 客户端动画状态：除 host 广播的 DSHState 外，额外含 WELCOME（欢迎）与
  // THINK_END（思考结束过渡态，由客户端在 THINKING → 非 THINKING 时触发一次）。
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
