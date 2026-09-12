
  // ══════════════════════════════════════════════════════════════════════
  //  CSS 注入
  // ══════════════════════════════════════════════════════════════════════
  //  （源码分片：看板娘容器/画布/控制浮层的样式注入）

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
