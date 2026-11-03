# pi-scratch

在 pi 里**临时叫出一个终端**，跑点一次性的东西，退出就回到 pi。再叫出来时
cwd 和环境变量还在上次的位置。

> 名字来源：scratch terminal / scratch shell（一次性、用完即弃的终端）。

## 需求

想在 pi 会话中随时开一个真正的终端：

- 必须是**真 tty**：vim、htop、`git rebase -i`、ssh、python REPL、tmux 都要能用
- **临时**：不污染会话上下文，不留在对话记录里，退出即恢复
- **快**：一个命令 / 一个快捷键就叫出来，cwd 跟着当前 session
- 一眼能看出「pi 还在，只是被挂起了」，别让人以为 pi 闪退了
- pi 原生的 `!` bash 只适合非交互命令，遇到全屏 TUI 程序会直接失败

## 用法

```
/term                        # 打开 scratch shell（cwd/env 接着上次）
/term git log --oneline -5   # 顺手跑一条命令，跑完自动回来
/term --reset                # 忘掉 cwd/env，重新来
ctrl+shift+t                 # 快捷键，等同 /term
/scratch                     # /term 的别名
```

实现方式：`tui.stop()` 把终端让给 `$SHELL`（`-i` 交互 / `-i -c` 单条命令），
退出后 `tui.start()` 复原 TUI 并重绘。所以里面可以放心跑任何全屏程序。
输入输出只走终端，**不进 pi 的对话上下文**，也不进 session 文件。

进去之后长这样：

```
<pi 最后一帧还在上面，不会被清掉>

▌ pi scratch · level 1 · restored · ~/.pi/agent/scratch/<session-id>
▌ exit / ctrl+d → 回到 pi · /term --reset 清掉 cwd/env

[scratch] meatroll@host pi-scratch %
```

- 横幅和 `[scratch]` 提示符前缀由 wrapper rc 打印，`--reset`/`/reload` 不会丢
- 讨厌 `[scratch]` 前缀就 `export PI_SCRATCH_NO_MARK=1`（写进你的 `.zshrc`）
- 单条命令模式（`/term <cmd>`）不打印横幅，保持输出干净

## 快捷键

默认 `ctrl+shift+t`。改法（写进 `~/.zshrc` 或 pi 的启动环境）：

```sh
export PI_SCRATCH_KEY=ctrl+shift+s   # 任意合法 KeyId，修饰键顺序无所谓
export PI_SCRATCH_KEY=none           # 干脆不要快捷键，只用 /term
```

- 非法值会回退到默认键，并在 pi 启动时提示
- 检查是否注册成功：`/hotkeys`
- `ctrl+shift+字母` 依赖终端的扩展键上报（Kitty 键盘协议 / xterm CSI-u）。
  iTerm2、Ghostty、WezTerm、Kitty、Windows Terminal 都支持；老终端或某些
  multiplexer 里可能收不到。**快速自测**：pi 自带的 `ctrl+shift+f`（搜索）如果能用，
  那 `ctrl+shift+t` 就没问题。不行就 `PI_SCRATCH_KEY=ctrl+alt+t` 退回老式按键

## Shell 复用是怎么做的

每个 session 一份状态目录：`~/.pi/agent/scratch/<session-id>/`

- `zsh`：用 `ZDOTDIR` 注入 wrapper，source 用户自己的 `~/.zshenv` / `~/.zshrc`，
  再 source 上次的 `state.sh`，然后挂 `precmd` + `zshexit` 钩子写回状态
- `bash`：用 `--rcfile` 做同样的三层（`~/.bash_profile` → `~/.bashrc` → state）
- 其它 shell：只保证能跑，不保证复用（会提示）

`state.sh` 就是一行 `cd -- '<上次的 pwd>'` 加一整段 `export -p`，所以复用的是
**cwd + 已导出环境变量**。历史记录仍在用户自己的 `HISTFILE`（`ZDOTDIR` 会把 zsh
默认历史文件挪进状态目录，wrapper 会改回去），所以和普通终端共享 history。

wrapper 里还有两道保险，避免状态文件把自己带偏：

- `PI_SCRATCH*` 这些控制变量不会被写进 `state.sh`
- source 完 `state.sh` 后，用**本次 spawn 的环境**覆盖 `PI_SCRATCH*`，
  旧状态文件无法劫持 level / 状态目录 / one-shot 标记

几个后果，用之前知道一下：

- state 里存的 `PATH` 会覆盖 `.zshrc` 里算出来的 `PATH`。所以在 scratch shell 里
  `conda activate` / `nvm use` 能留到下次；反过来，你新改了 `.zshrc` 的 `PATH`，
  scratch shell 里看到的还是旧的 —— `/term --reset` 就好
- 未 export 的变量、shell 函数、后台 job 不跨次保留（要这些就得用 tmux）
- 同一个 session 在别处最后写赢；两个 session 互不影响
- 状态目录可以直接删，`/term --reset` 就是干这个
- 在 scratch shell 里再跑 `pi` 是允许的，但会被盯上 —— 见下面「嵌套」一节

## 嵌套（pi → shell → pi）

真终端本来就该能跑任何东西，所以不禁止嵌套，只加两道护栏：

1. **不再叠终端**：当前 pi 自己就跑在 scratch shell 里时（`level ≥ 1`），
   `/term` / `ctrl+shift+t` 会被直接拒绝并提示先 `exit` 回外层。
   确需嵌套用 `/term --force`，或 `PI_SCRATCH_ALLOW_NESTED=1`。
   一次性命令不受限：`/term git commit` 在嵌套 pi 里照常能用（跑完即退，不叠层）。
2. **不和挂起的外层 pi 抢 session 文件**：起 shell 时把父 session 路径写进
   `PI_SCRATCH_PARENT_SESSION`，嵌套 pi 启动时比对。撞上同一个文件就红字报
   `⛔ same session as parent pi`（两个 pi 会各写一条分支），用 `/new` 或 `exit`；
   没撞上只提示 `⚠ nested pi · scratch level N` —— 这就是正常的「子目录里再开一个 pi」

## 开发

```sh
# 直接在 pi 里加载，改完 /reload
pi -e ./index.ts

# 或装成常驻扩展
pi install ./          # 本地 path 安装
```

```sh
npm install            # peer deps：@earendil-works/pi-coding-agent / pi-tui
npm run typecheck
npm test               # 19 个用例：真跑 zsh/bash，验证状态/横幅/history/防劫持/嵌套护栏
```

参考实现：`pi/packages/coding-agent/examples/extensions/interactive-shell.ts`
（Pi 官方示例，用 `user_bash` 事件拦截 `!cmd`；本项目改成主动召唤）。

## 待定 / TODO

- [x] 快捷键可配置（`PI_SCRATCH_KEY`，默认 `ctrl+shift+t`）
- [ ] 快捷键写进 pi settings 而不是环境变量（目前只能 env / shell rc）
- [ ] 一次性命令的输出回填到对话（`/term -c "..."` 跑完把 stdout 交给模型）
- [ ] tmux 后端：真·持久 shell（后台 job、未导出变量都能留），detach 用 `ctrl+b d`
- [ ] 嵌入式终端面板（overlay + PTY）：pi-tui 已依赖 `@xterm/headless`，
      理论上可以在 overlay 里画一个悬浮终端；需要 node-pty，成本高，暂不做
- [ ] 状态目录清理：session 删了以后 `~/.pi/agent/scratch/*` 没人管

## 设计取舍

| 方案 | 真 tty | 会话级复用 | 成本 | 备注 |
|---|---|---|---|---|
| 挂起 TUI + `$SHELL` + state 文件（当前） | ✅ | cwd/env | 低 | 全屏接管，无外部依赖 |
| tmux attach | ✅ | 全部（含 job / 函数） | 低 | 依赖 tmux，嵌套 tmux 有点绕 |
| overlay + PTY + xterm 渲染 | ✅ | 全部 | 高 | 悬浮面板好看，但要 node-pty 和终端模拟器集成 |
