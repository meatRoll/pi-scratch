# pi-scratch

[English](README.md) · **中文**

在 [pi](https://github.com/earendil-works/pi) 里**临时叫出一个终端**。想跑什么
一次性的事情就跑，`exit` 回到 pi 原来那一屏；下次再叫出来时，shell 还在上次的
目录，导出的环境变量也还在。

## 为什么需要

pi 原生的 `!bash` 只适合非交互命令，遇到需要真 tty 的程序就不行了。这个扩展给你
一个随叫随到的真终端：

- **真 tty** —— vim、htop、`git rebase -i`、ssh、Python REPL、tmux 都能跑
- **一次性** —— 输入输出不进 pi 的对话上下文，也不进 session 文件
- **一个键** —— `/term` 或 `ctrl+shift+t`，cwd 跟着当前 session
- **看得出 pi 没死** —— pi 最后一帧留在屏幕上，提示符前面加 `[scratch]` 标记，
  不会再把「挂起」误认成「闪退」
- **记得住** —— cwd 和已导出环境变量下次自动复原

## 环境要求

- pi >= 1.4.0（扩展走 jiti 加载，不用编译）
- `zsh` 或 `bash` 才有状态复用（其它 shell 能跑，但不记忆）
- macOS / Linux

## 安装

```sh
pi install git:github.com/meatRoll/pi-scratch@v1.0.1
```

开发时改装本地目录，改完 `/reload` 生效：

```sh
pi install ./            # 或临时跑一次：pi -e ./index.ts
pi update --extensions   # 拉取后对账
```

卸载：

```sh
pi remove git:github.com/meatRoll/pi-scratch@v1.0.1
```

## 用法

| 输入 | 作用 |
|---|---|
| `/term` | 打开 scratch shell，复原 cwd + 已导出环境变量 |
| `/term <命令>` | 在这个 shell 里跑一条命令，跑完自动回来 |
| `/term --reset` | 忘掉保存的 cwd/env，重新开始 |
| `/term --force` | 允许在嵌套的 pi 里开（别名 `--nested`，见下面「嵌套」一节） |
| `/scratch` | `/term` 的别名 |
| `ctrl+shift+t` | 快捷键，等同 `/term` |

实现方式：`tui.stop()` 把终端让给 `$SHELL`（交互用 `-i`，单条命令用 `-i -c`），
退出后 `tui.start()` 并重绘 —— 所以全屏程序随便跑。终端的读写**不会**进入 pi 的
上下文，也不写进 session 文件。

进去之后长这样：

```
<pi 最后一帧还在上面，屏幕没有被清掉>

▌ pi scratch · level 1 · restored · ~/.pi/agent/scratch/<session-id>
▌ exit / ctrl+d → back to pi · /term --reset clears cwd/env

[scratch] ➜  pi-scratch
```

- 横幅和 `[scratch]` 前缀来自 wrapper rc，每次启动都会重写 —— `/reload`、升级、
  `--reset` 之后都还在
- 不喜欢这个标记：`export PI_SCRATCH_NO_MARK=1`
- 单条命令模式（`/term <cmd>`）不打印横幅，输出保持干净

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `PI_SCRATCH_KEY` | `ctrl+shift+t` | 快捷键；任意 pi key id，`none` 表示不要快捷键 |
| `PI_SCRATCH_NO_MARK` | 未设置 | 设成任意值即去掉 `[scratch]` 提示符前缀 |
| `PI_SCRATCH_ALLOW_NESTED` | 未设置 | `1` 允许在嵌套的 pi 里开终端 |

`ctrl+shift+字母` 依赖终端的扩展键上报（Kitty 键盘协议或 xterm CSI-u）。iTerm2、
Ghostty、WezTerm、Kitty、Windows Terminal 都支持；老终端和部分 multiplexer 不支持。
**快速自测**：pi 自带的 `ctrl+shift+f`（搜索）能用，`ctrl+shift+t` 就没问题；不行就
`PI_SCRATCH_KEY=ctrl+alt+t`。注册结果用 `/hotkeys` 查。

## 状态复用是怎么做的

每个 session 一个状态目录：`~/.pi/agent/scratch/<session-id>/`

- **zsh** —— 用 `ZDOTDIR` 指向生成的 wrapper，它先 source 你的 `~/.zshenv`、
  `~/.zshrc`，再 source 保存的 `state.sh`，最后挂 `precmd` + `zshexit` 钩子写回
- **bash** —— 用 `--rcfile` 做同样三层（`~/.bash_profile` → `~/.bashrc` → state）
- **其它 shell** —— 能跑，但不记忆（会提示）

`state.sh` 就是一行 `cd -- '<上次的 pwd>'` 加一整段 shell 自己的 `export -p`，所以
留下来的是 **cwd + 已导出变量**。历史记录不受影响：wrapper 把 `HISTFILE` 指回你
自己的文件（`ZDOTDIR` 否则会把 zsh 默认历史文件挪进状态目录）。

两道保险，防止旧状态文件把新 shell 带偏：

- `PI_SCRATCH*` 这些控制变量永远不写进 `state.sh`
- source 完 `state.sh` 后，用**本次 spawn 的环境**覆盖它们 —— 旧文件改不了 level、
  状态目录和 one-shot 标记

## 嵌套（pi → shell → pi）

真终端本来就该能跑任何东西，所以不禁止嵌套，只加两道护栏：

1. **不再叠终端**：当前 pi 自己就跑在 scratch shell 里（`level ≥ 1`）时，`/term`
   和快捷键会被直接拒绝，并提示先 `exit` 回外层。确需嵌套用 `/term --force`，
   或 `PI_SCRATCH_ALLOW_NESTED=1`。一次性命令不受限：`/term git commit` 在嵌套
   pi 里照常能用，因为那个 shell 跑完就退。
2. **不抢同一个 session 文件**：起 shell 时把父 pi 的 session 路径写进
   `PI_SCRATCH_PARENT_SESSION`，嵌套 pi 启动时与自己的比对。撞上同一个文件 →
   `⛔ same session as parent pi`（两个 pi 会各写一条分支），用 `/new` 或 `exit`；
   不同文件 → 只提示 `⚠ nested pi · scratch level N`，就是正常的「子目录里再开
   一个 pi」。

## 注意事项

- 保存的 `PATH` 会覆盖 `.zshrc` 里算出来的 `PATH`。这正是 `conda activate` /
  `nvm use` 能跨次保留的原因，但也意味着你新加到 `.zshrc` 的 `PATH` 要
  `/term --reset` 之后才看得到
- 未导出的变量、shell 函数、后台 job 不跨次保留（那需要 tmux 后端）
- 同一个 session 开两个 shell：后写的赢；不同 session 之间互不影响
- 状态目录随时可以删，`/term --reset` 干的就是这件事

## 开发

```sh
npm install          # peer deps：@earendil-works/pi-coding-agent、@earendil-works/pi-tui
npm run typecheck
npm test             # 19 个用例：真跑 zsh/bash，状态、横幅、history、防劫持、嵌套护栏
```

参考实现：pi 自带的
`packages/coding-agent/examples/extensions/interactive-shell.ts` —— 官方示例是挂
`user_bash` 事件让 `!cmd` 变成交互式；本项目改成主动召唤。

## 路线图

- [x] 快捷键可配置（`PI_SCRATCH_KEY`，默认 `ctrl+shift+t`）
- [ ] 快捷键从 pi settings 读，而不是环境变量
- [ ] 一次性命令的输出回填到对话（`/term -c ...`）
- [ ] tmux 后端：真·持久 shell（后台 job、函数都能留），用 `ctrl+b d` detach
- [ ] 嵌入式终端面板（PTY + `@xterm/headless`），需要 node-pty，暂不做
- [ ] session 删除后清理 `~/.pi/agent/scratch/*`

## 设计取舍

| 方案 | 真 tty | 跨次复用 | 成本 | 备注 |
|---|---|---|---|---|
| 挂起 TUI + `$SHELL` + state 文件（当前） | ✅ | cwd/env | 低 | 无外部依赖，全屏接管 |
| tmux attach | ✅ | 全部（job、函数） | 低 | 依赖 tmux，嵌套 tmux 有点绕 |
| overlay + PTY + xterm 渲染 | ✅ | 全部 | 高 | 好看，但要 node-pty 和终端模拟器集成 |

## License

MIT
