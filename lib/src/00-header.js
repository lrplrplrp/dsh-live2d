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

  // ── 临时调试日志（排查「输出对话 SPEAKING 不播放动画」）──
  // 确认问题后请删除本块及所有 L2DDBG(...) 调用。
  const DBG_VERSION = 'spk1'
  const _dbgT0 = Date.now()
  // 带相对时间戳（毫秒），便于测量各状态实际持续时长
  const L2DDBG = (...a) => { try { console.log('[L2D-SPK][' + DBG_VERSION + '][' + (Date.now() - _dbgT0) + 'ms]', ...a) } catch (e) {} }
  L2DDBG('client loaded', location.href)

