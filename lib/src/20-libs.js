
  // ══════════════════════════════════════════════════════════════════════
  //  本地库加载器（通过 host 端 webserver 路由）
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：本地 Live2D 库脚本加载 + 浏览器自动播放策略的音频解锁）

  let libsLoaded = false

  // ── 临时计时（排查首开约 10s 空白）──
  const PERF_T0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  function PERF(label) {
    try {
      const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      console.log('[L2D-PERF] +' + Math.round(t - PERF_T0) + 'ms  ' + label)
    } catch (e) {}
  }
  PERF('client module loaded')

  /**
   * 并行加载全部本地库脚本。
   *
   * 关键点：这些脚本互相之间有「执行顺序」依赖（index.min.js 在加载期就要用 PIXI），
   * 但没有「下载」依赖。普通 <script>（不带 async/defer）由浏览器保证【按文档顺序执行】，
   * 即便并行下载也如此。因此一次性插入全部 script 标签，让浏览器并行下载，再把各
   * onload 一起 await —— 相比原先 for-await 逐个串行加载，省掉 3 次串行往返。
   */
  function loadScripts(urls) {
    return Promise.all(urls.map(function(url) {
      return new Promise(function(resolve, reject) {
        if (document.querySelector('script[src="' + url + '"]')) {
          PERF('script already present: ' + url.split('/').pop())
          resolve()
          return
        }
        const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
        const script = document.createElement('script')
        script.src = url
        script.onload = function() {
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
          PERF('script loaded: ' + url.split('/').pop() + ' (' + Math.round(now - started) + 'ms)')
          resolve()
        }
        script.onerror = function() { reject(new Error('Failed to load ' + url)) }
        // 按调用顺序 append：非 async 脚本按文档顺序执行，保证 index.min.js 在 pixi 之后
        document.head.appendChild(script)
      })
    }))
  }

  async function ensureLibsLoaded() {
    if (libsLoaded) return true
    PERF('ensureLibsLoaded start')
    try {
      await loadScripts(LIB_SCRIPTS.map(function(name) { return LIB_BASE + name }))
      libsLoaded = true
      PERF('ensureLibsLoaded done')
      // 库就绪后立刻预热模型文件（含体积最大的贴图），与后续的引擎初始化重叠，
      // 让 Live2DModel.from 直接从缓存取，缩短首开等待（刷新时本就有缓存，故无感）。
      preloadModelAssets()
      return true
    } catch (err) {
      console.warn('[dsh-live2d] Failed to load Live2D libraries from local server:', err)
      return false
    }
  }

  // 预热当前模型的 model3.json 及其引用的贴图/动作文件。
  // 仅用 <link rel=preload> / fetch 拉取进缓存，不解析，失败也不影响正常加载路径。
  let _assetsPreloaded = false
  function preloadModelAssets() {
    if (_assetsPreloaded) return
    _assetsPreloaded = true
    let entry = null
    try {
      const cfg = getConfig()
      const idx = getActiveModelIndex(cfg.models)
      entry = cfg.models[idx]
    } catch (e) { return }
    const url = entry && entry.url
    if (!url) return

    // 先取 model3.json，再按 FileReferences 预热贴图与动作（仅贴图通常占大头）
    fetch(url, { cache: 'force-cache' })
      .then(function(r) { return r.ok ? r.json() : null })
      .then(function(model3) {
        if (!model3 || !model3.FileReferences) return
        const fr = model3.FileReferences
        const base = url.slice(0, url.lastIndexOf('/') + 1)
        const targets = []
        // 贴图（体积最大，优先）
        if (Array.isArray(fr.Textures)) {
          for (const t of fr.Textures) if (typeof t === 'string') targets.push(base + t)
        }
        // 动作/表情/物理等 JSON（体积小但数量多，一并预热）
        const motions = fr.Motions || {}
        for (const g of Object.keys(motions)) {
          const list = Array.isArray(motions[g]) ? motions[g] : []
          for (const mo of list) {
            const f = typeof mo === 'string' ? mo : (mo && (mo.File || mo.file))
            if (typeof f === 'string') targets.push(base + f)
          }
        }
        for (const e of (fr.Expressions || [])) {
          const f = typeof e === 'string' ? e : (e && (e.File || e.file))
          if (typeof f === 'string') targets.push(base + f)
        }
        for (const key of ['Physics', 'Pose', 'DisplayInfo']) {
          if (typeof fr[key] === 'string') targets.push(base + fr[key])
        }
        for (const t of targets) {
          try { fetch(t, { cache: 'force-cache' }).catch(function() {}) } catch (e) {}
        }
      })
      .catch(function() {})
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
