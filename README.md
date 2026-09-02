# DSH Live2D 看板娘 🎭

**在 DeepSeek Harness Web GUI 中渲染可拖动的 Live2D 模型，由 DSH 真实工作状态实时驱动动画，并支持眼睛跟随鼠标。**

[English](README_EN.md) · [npm](https://www.npmjs.com/package/dsh-live2d) · [GitHub](https://github.com/lrplrplrp/dsh-live2d)

## 功能

- 🎭 **Live2D 模型渲染** — 在 DSH Web GUI 中显示 Live2D 看板娘
- 🖱️ **拖拽移动** — 通过右下角拖拽图标移动看板娘，位置自动保存
- 🎡 **滚轮缩放** — 鼠标滚轮实时缩放模型大小，缩放自动保存
- 📐 **画布大小调整** — 悬停画布时显示右下角手柄，拖动改变画布尺寸
- 👀 **眼睛跟随鼠标** — 模型视线随光标移动（可在设置页开关）
- 🎬 **DSH 状态驱动动画** — 基于 Agent 状态（思考/工作/完成/错误）实时切换对应动画
- ⚡ **实时推送** — 状态变化通过 SSE 即时推送，动画切换零延迟
- 📦 **内置默认模型** — 开箱即带的 DeepSeek Live2D 模型与完整动画映射，安装即可用
- 📂 **模型目录自动扫描** — 把 `.model3.json` 模型文件夹放进 `assets/` 即被自动识别
- ⚙️ **完整设置页** — DSH 设置面板中的 Live2D 配置页面

## 安装

### 1. 完全退出 DSH

关闭 DSH Host（不只是浏览器标签页）。

### 2. 命令安装

```bash
# 从本地目录安装（开发/调试）
dsh plugin --profile web add link:/path/to/dsh-live2d

# 或从 npm 安装（发布后）
dsh plugin --profile web add dsh-live2d
```

### 3. 启动 DSH

```bash
dsh web
```

启动后看板娘会自动出现在页面左下角，并以内置的 DeepSeek 模型与动画映射运行。

## 交互说明

| 操作 | 方式 |
|------|------|
| 移动看板娘 | 拖动右下角的 ✥ 拖拽图标 |
| 缩放模型 | 鼠标滚轮（悬停在画布上滚动） |
| 调整画布大小 | 鼠标悬停画布时，拖动右下角的蓝色边角手柄 |
| 眼睛跟随 | 全局开启，视线自动看向光标；可在设置页关闭 |

## 模型与动画配置

配置保存在浏览器 localStorage（key: `dsh-live2d.v1`），也可在 **DSH 设置 → Live2D 看板娘** 中可视化编辑。

### 内置默认动画映射

插件内置的 DeepSeek 模型已预置以下映射，安装即可使用：

| DSH 状态 | 说明 | 默认动画 |
|---------|------|---------|
| `IDLE` | 空闲待机 | Idle 组 motion |
| `THINKING` | Agent 开始思考 | Anima 组 thinking motion |
| `THINK_END` | 思考结束，准备输出 | Anima 组 thinkend motion |
| `WORKING` | 工具调用中 | Anima 组 speak motion |
| `SUCCESS` | 任务完成 | happy 表情 |
| `ERROR` | 任务出错 | unhappy 表情 |

每个模型可独立配置：
- `motion`: `{ "group": "组名", "index": 0 }` — 播放动作（index 为组内序号，留空随机）
- `expression`: `"表情名"` — 设置表情

### 添加本地模型

1. 将含 `.model3.json` 的模型文件夹复制到插件的 `assets/` 目录下（如 `assets/my_model/`）。
2. 打开 **DSH 设置 → Live2D 看板娘**，点击「刷新模型列表」。
3. 模型即出现在列表标签中，可在下方配置其动画映射。

无需手动编辑路径——扫描自动识别 `assets/` 下所有子目录中的 `model3.json`。

## 通用设置

设置页顶部「通用设置」卡片提供：

- **眼睛跟随鼠标** — 勾选后模型视线随光标移动；关闭后视线回到正中。开关即时生效并持久化。

## 与原项目的关系

本插件基于 [lrplrplrp/live2d](https://github.com/lrplrplrp/live2d) 改造，移除了对话框、小游戏、外部 API 等，新增了 DSH 状态驱动、拖拽/缩放/画布调整、眼睛跟随、实时推送等能力，并深度集成 DSH 设置页。

## 技术栈

- **PIXI.js 7.x** — 2D 渲染引擎
- **pixi-live2d-display** — Live2D Cubism SDK for Web（含 `model.focus` 视线跟随）
- **DSH 插件系统** — `window.__ModuleLoader__` + `ctx.slots` + `webServer` SSE

## License

MIT
