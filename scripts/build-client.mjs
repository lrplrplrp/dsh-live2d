#!/usr/bin/env node
// dsh-live2d — 客户端单文件构建脚本。
//
// 背景：host 端（@deepseek-ai/dsh-client-modules）只读取单个 `lib/client.js` 并原样
// 投递给浏览器（无打包器，client 侧 require 只能解析已注册的 dsh.client 模块，无法
// import 本地文件）。因此源码按功能拆分在 `lib/src/`，由本脚本按文件名顺序拼接生成
// 唯一的投放产物 `lib/client.js`。
//
// 同时把 `lib/shared/states.js`（host/client 的状态常量单一来源）内联进来：剥离
// ESM 的 `export` 关键字，使其在 client 的工厂闭包内等价于一段普通声明。
//
// 用法：
//   node scripts/build-client.mjs          # 生成 lib/client.js
//   node scripts/build-client.mjs --check  # 仅校验产物是否与源码一致（CI/回归用）

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'lib', 'src')
const OUT = join(ROOT, 'lib', 'client.js')
const SHARED = join(ROOT, 'lib', 'shared', 'states.js')

const MARK_A = '// >>> shared/states.js (generated — do not edit here) >>>'
const MARK_B = '// <<< shared/states.js <<<'

const GENERATED_NOTICE = [
  '// ⚠️ 本文件由 scripts/build-client.mjs 从 lib/src/ 源码拼接生成，请勿直接编辑。',
  '//    修改请改 lib/src/*.js 或 lib/shared/states.js，然后运行 `npm run build`。',
  '//    `npm run check` 会校验本产物与源码是否一致。',
  '',
].join('\n')

/** 把共享 ESM 模块转成可内联进 client 工厂闭包的普通声明片段。 */
function inlineShared() {
  const raw = readFileSync(SHARED, 'utf8')
  const body = raw
    .split('\n')
    // 去掉 ESM export 关键字（本文件只导出常量，内联后直接是闭包内声明）
    .map((line) => line.replace(/^export\s+const\s/, 'const '))
    .filter((line) => !/^import\s/.test(line))
    .join('\n')
    .trimEnd()
  return [
    '  ' + MARK_A,
    '  // 由 scripts/build-client.mjs 从 lib/shared/states.js 内联生成，请勿直接修改此处。',
    ...body.split('\n').map((l) => (l.length ? '  ' + l : l)),
    '  ' + MARK_B,
    '',
  ].join('\n')
}

function build() {
  const files = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort() // 文件名前缀（00/10/20/...）决定拼接顺序

  if (files.length === 0) throw new Error(`no source fragments found in ${SRC_DIR}`)

  const parts = files.map((f) => readFileSync(join(SRC_DIR, f), 'utf8'))

  // shared/states.js 内联在 config 片段（10-）之前，保证 DSHState 在最早被使用前已声明。
  const insertAt = parts.findIndex((_, i) => files[i].startsWith('10-'))
  const withShared = insertAt === -1
    ? [...parts, inlineShared()]
    : [...parts.slice(0, insertAt), inlineShared(), ...parts.slice(insertAt)]

  let out = GENERATED_NOTICE + withShared.join('')
  if (!out.endsWith('\n')) out += '\n'
  return out
}

const generated = build()
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch {}
  if (current !== generated) {
    console.error('[build-client] lib/client.js 与 lib/src/ 源码不一致，请运行 `npm run build`。')
    process.exit(1)
  }
  console.log('[build-client] 产物与源码一致 ✓')
} else {
  writeFileSync(OUT, generated)
  console.log(`[build-client] 已生成 ${OUT}（${generated.length} 字节）`)
}
