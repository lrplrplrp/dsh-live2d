// dsh-live2d — 共享的状态常量（host 与 client 的单一来源）。
//
// host 端（lib/index.js）直接 `import { DSHState }`；
// client 端（lib/client.js）由 scripts/build-client.mjs 在构建时内联本文件内容
// （浏览器侧无法 import 本地文件，client.js 必须保持单文件投放）。
//
// 本文件不得依赖 node 或浏览器任何专有 API，保持“纯数据 + 纯函数”以便两端复用。

export const DSHState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  SPEAKING: 'SPEAKING', // 开始输出对话内容
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
})
