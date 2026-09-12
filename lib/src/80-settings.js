
  // ══════════════════════════════════════════════════════════════════════
  //  设置页组件
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：设置页组件：模型目录、动画映射、时间映射、通用开关）

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
