# 旁听席 Side Seat

> 就当前这场会话问一句，答案不进主会话。

一个 DSH（DeepSeek Harness）插件。它在正在进行的会话旁边开一条**旁路**：记得这场会话说过什么，
回答你对其中某处的疑问，而**除非你明确要求**，一个字都不写进主对话。

English: [README.md](./README.md)

---

## 为什么做这个

你在和 agent 一起干活。它的某段输出里有个细节让你不舒服：一个可疑的 p 值、一步你没跟上的推导、
一条你不信服的结论。在主会话里问，一次付三笔账：

1. **上下文** —— 这段问答永久留在 transcript 里，之后每次请求都带着它；
2. **注意力** —— agent 得放下手上的事来解释，再切回来；
3. **判断成本** —— 要开新会话问，你得先决定"复制哪几段给它看"。这一步才是真正的成本，
   也是为什么大多数疑问被默默咽下去。

被咽下去的疑问，通常就是后来要返工的地方。这个插件让它变得廉价。

## 你能得到什么

**右栏面板。** 右栏「开始」页 → *旁听席*。输入框问一句（Ctrl+Enter 发送），可切档位（L1 外行 …
L4 较真）和模式（解释 / 质疑）。答案按会话保存，重开面板还在。对话里什么都不留。

**每条消息一个入口。** 每条已完成的 assistant 消息，动作行（复制 / 赞 / 踩 / 分享 那一排）多一个气泡按钮。
点它 → 面板打开并**锚定到那一条**，接下来的问题针对那一步，而不是整场会话。

**斜杠命令**（不开面板也能用）：

```
/seat 这个 p 值 0.03 是怎么算出来的？
/seat l1 什么是多重检验校正？              # L1 … L4
/seat ? 这个结论站得住吗                   # 质疑模式
/seat @187 这一步的 df 怎么估的？          # 把锚点钉在事件 187
/seat here                                 # 列出最近几条输出的事件号
/seat ls | show 1 | use 1 | del 1 | new
/seat export 1                             # 导出成 markdown
/seat selftest                             # 诊断：模型、快照、包大小、线程数
/seat to-main 1                            # 预览提炼卡（不发送）
/seat to-main 1 yes                        # 确认送入主会话（加 wake 同时唤醒它）
```

`l1`–`l4` 是**可统计的形态约束**（术语白名单、字数上限、是否必须给反例），不是语气。
`to-main` 是两步：预览 → `yes` 才写入，因为日志 append-only，送进去撤不回来。

## 安装

在没有上 npm 之前，从本地目录或 git 地址装。

**本地目录**：DSH 桌面端 → 插件 → 按路径安装；或 `dsh` 在 PATH 里时：

```bash
dsh plugin add /absolute/path/to/side-seat
# 仓库发布后
dsh plugin add https://github.com/Soyouchin/dsh-Side-Seat
```

安装后需要重启 DSH（客户端那一半也可以只刷新页面）。

## 配置

插件从 profile 的 `cordis.patch.yml` 读自己那一行的 `config`：

```yaml
config:
  level: 3                 # 默认档位 1-4
  mode: explain            # explain | challenge
  provider: deepseek       # 不填 = 用会话默认模型
  model: deepseek-chat
  budgetTokens: 12000      # 上下文包的硬预算
  maxThreads: 20
  maxTokens: 1600          # 单次回答上限
  selfTest: false          # true = 每次激活跑一次诊断
  storeDir: '~/.dsh/side-seat'
```

故意不声明 `Config` schema：schema 类型来自 DSH 安装里的包，链接安装的插件解析不到。
代价是配置没有校验，写错在使用时才报。

## 工作原理

```
会话日志 ──(sessionQuery)──▶ 上下文包 ──▶ 一次 llm.stream() ──▶ 回答
                                  │                            │
                     锚点窗口 + 骨架 + 索引                    │
                                                               ▼
                              右栏面板 ◀── @Remote ── sideSeat/ask
                                                               │
                     to-main：提炼卡 ──▶ agent.inject() ─────────┘（只在你确认后）
```

- **不是子会话、不是 fork、不开工具。** 子会话每问一句就多一个真实会话（进列表、要写死工具白名单、
  多轮 agent 循环几秒起）；fork 复制全量上下文。一个疑问只需要一次带上下文的模型调用。
- **上下文包分层且硬封顶**：锚点附近原文 + 每条消息一行的骨架 + 问题索引，三级降级 + 字符级截断兜底。
  真实会话 1800 个事件 → 约 4200 / 12000 tokens。
- **零污染是架构保证的**：不建会话、不注册工具、不写日志。唯一的回流是 `to-main`，且必须预览 + `yes`，
  注入的是一条带固定前缀（`【旁听席提炼 · 非用户原话 · 未经主会话验证】`）的 user 消息。
- **解释者知道自己是临时的**：system prompt 写明它是用完即弃的旁听席、输出默认丢弃、引用会话内内容必须带
  `[seq]`、被要求干活时要说明"超出旁听席范围"。

## 写给 DSH 插件作者（都是真踩过的坑）

| 坑 | 现象 | 事实 |
|---|---|---|
| typert face 注册两次（手动 `ctx.typert.register()` **和** `./typert` 导出） | 客户端启动即崩 | `dsh-typert-loader` 会自动注册所有导出 `./typert` 的已挂载条目；重复的 package face 让 loader 整批失败，**所有** strict 端点（含 `settings/describe`）一起失去定义 |
| 页面类型没有 `guide` | 面板存在但打不开 | 右栏开始页只列 guide 条目；`title` 必须是函数 |
| strict codec 缺 `create()` | `strict codec has no create() factory` | 客户端贡献在 `$mount` 时校验，每个 strict codec 都要工厂 |
| 直接点 `ctx.remote.<ns>` | `cannot get property … without inject` | 命名空间服务在 `$mount` 之后才存在，要用 `ctx.get('remote.<ns>')` 并重试；`ctx.sidebarRight` 同理 |
| 服务写成对象字面量 | `gateway/binding-invalid` | 必须是**类实例**：方法在原型上，且挂 `typertRemote = { service, serviceKey, namespace }` |
| 调用少传参数 | `expected N business argument(s)` | 网关按描述符精确比对参数个数，可选参数也要占位传 `undefined` |
| 服务用 `#private` 存依赖 | `gateway/internal`（消息被吞） | Cordis 通过服务代理调用，`this` 是代理，私有字段读不到。用普通属性；并把失败**当作数据返回** |
| 只读一种消息形状 | 答案静默变空 | `assistant/message` 在 `data.message.content`；`user/message`、`tool/result` 在 `data.content` |
| 按 `data.turn` 取锚点窗口 | 预算被一个回合吃光 | `data.turn` 在会话内会重置，窗口要按**事件序号距离** |
| 以为命令结果是 markdown | `**加粗**` 原样显示 | 命令结果渲染成「折叠一行 + 260px `<pre>`」，所以输出纯文本、结论放第一行 |

后四条都有离线断言（原型/签名、codec 形状、调用 arity、宿主与客户端端点一致性），在 `npm test` 里失败，
而不是在别人的浏览器里失败。

## 验证

```bash
npm test                      # 56 项断言，四个套件
node tools/replay.mjs 12000   # 用真实会话日志跑上下文包
```

- **56 项断言全绿**：`test/core.test.mjs`（31）、`test/integration.test.mjs`（12）、`test/client.test.mjs`（8，
  真的执行客户端模块）、`test/package.test.mjs`（5，打包完整性：每个 export 都有对应文件、patch 插入本包、
  客户端 id 与包名一致、图标自包含）。
- **真机跑通**：命令路径端到端约 1.4 秒；面板的 ping 往返通过网关。
- **未验证**：回答**质量**（只能测形态，测不了对错）；面板除"能渲染"之外的视觉细节——这个环境没有浏览器
  自动化，至今每个 UI 回归都是人点出来的。

## 已知限制

- 还没有流式输出：面板显示转圈，然后整段出现。
- `to-main` 只在命令行里（面板内还没有提炼按钮）。
- 面板的问答按会话存成 JSON 文件（`storeDir`），没有加密。

## 许可

MIT，见 [LICENSE](./LICENSE)。
