
  // ══════════════════════════════════════════════════════════════════════
  //  本地库加载器（通过 host 端 webserver 路由）
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：本地 Live2D 库脚本加载 + 浏览器自动播放策略的音频解锁）

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
