# pi-scratch

在 pi 里**临时叫出一个终端**，跑点一次性的东西，退出就回到 pi。

> 名字来源：scratch terminal / scratch shell（一次性、用完即弃的终端）。

## 需求

想在 pi 会话中随时开一个真正的终端：

- 必须是**真 tty**：vim、htop、`git rebase -i`、ssh、python REPL、tmux 都要能用
- **临时**：不污染会话上下文，不留在对话记录里，退出即恢复
- **快**：一个命令 / 一个快捷键就叫出来，cwd 跟着当前 session
- pi 原生的 `!` bash 只适合非交互命令，遇到全屏 TUI 程序会直接失败

## 用法（v0）

```
/term                  # 打开交互式 shell（当前 session 的 cwd）
/term git log --oneline -5   # 顺手跑一条命令，跑完自动回来
ctrl+alt+t             # 快捷键，等同 /term
/scratch               # /term 的别名
```

实现方式：`tui.stop()` 把终端整个让给 `$SHELL`（`-i` 交互 / `-lc` 单条命令），
退出后 `tui.start()` 复原 TUI 并重绘。所以里面可以放心跑任何全屏程序。

输入输出只走终端，**不进 pi 的对话上下文**，也不进 session 文件。

## 开发

```sh
# 直接在 pi 里加载，改完 /term 前 /reload
pi -e ./index.ts

# 或装成常驻扩展
pi install ./          # 本地 path 安装
```

```sh
npm install            # peer deps：@earendil-works/pi-coding-agent / pi-tui
npm run typecheck
```

参考实现：`pi/packages/coding-agent/examples/extensions/interactive-shell.ts`
（Pi 官方示例，用 `user_bash` 事件拦截 `!cmd`；本项目改成主动召唤）。

## 待定 / TODO

- [ ] 快捷键冲突检查：`ctrl+alt+t` 在部分终端被占用，可能要改成可配置
- [ ] session 级别的 shell 复用：连续 `/term` 保留 cwd / 环境变量 / 历史
      （目前每次都是新 shell；可选 `tmux new-session -A -s scratch-<id>`）
- [ ] 一次性命令的输出回填到对话（`/term -c "..."` 跑完把 stdout 交给模型）
- [ ] 嵌入式终端面板（overlay + PTY）：pi-tui 已依赖 `@xterm/headless`，
      理论上可以在 overlay 里画一个悬浮终端；需要 node-pty，成本高，暂不做
- [ ] 给 agent 一个 `scratch` tool？大概率不需要，agent 已有 bash tool

## 设计取舍

| 方案 | 真 tty | 成本 | 备注 |
|---|---|---|---|
| 挂起 TUI + `$SHELL`（当前） | ✅ | 低 | 全屏接管，简单可靠 |
| tmux 分屏 | ✅ | 低 | 只在 tmux 内可用，得管 pane 生命周期 |
| overlay + PTY + xterm 渲染 | ✅ | 高 | 悬浮面板好看，但要 node-pty 和终端模拟器集成 |
