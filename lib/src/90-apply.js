
  // ══════════════════════════════════════════════════════════════════════
  //  插件入口
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：插件入口：向 DSH 注入 shell.overlay 与 settings.section）

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
