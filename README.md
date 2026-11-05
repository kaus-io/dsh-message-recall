# 消息撤回（Message Recall）

在 DeepSeek Harness Web 的每条已发送消息下方，复制键旁边增加一个「撤回」键（↺）。

- 点击撤回键 → 行内确认胶囊：「撤回这条消息及其后 N 条提问？」→ 确定 / 取消。
- 确认后：对话回退到该消息**之前**，原文被放回输入框，可直接修改后重新发送。
- 被撤回的旧会话会自动归档（可在侧边栏归档区恢复），新会话沿用原标题，观感上像"原地编辑了这条消息"。

参考 opencode 的 revert 交互与 [DSH-EasyRewrite](https://github.com/Renzic-Stone/DSH-EasyRewrite) 的召回键位置（复制键旁、悬停出现）。

## 源码与构建（TypeScript）

| 源码 | 产物 | 说明 |
| --- | --- | --- |
| `src/client.tsx` | `client.js` | Client 半边：槽位覆盖、动作行、撤回流 |
| `src/host.ts` | `index.js` | Host 半边（空 `apply`） |

产物已提交，profile 直接加载 `client.js`/`index.js`，安装不触发构建。修改源码后在工作区根目录执行：

```sh
pnpm run build      # esbuild：CJS + window.__ModuleLoader__.load 包装
pnpm run typecheck  # tsc --noEmit，strict
node smoke.mjs      # 模块形状 / 注册参数 / 渲染冒烟测试
```

`react`、`react/jsx-runtime` 是 external，由宿主模块表提供，不打包进产物。

## 实现方式

DSH 的消息行没有可追加动作的插槽，用户消息行由 `conversation.chat.node` 的 keyed cell（`user`）渲染。本插件：

1. 以 `priority: -10` 覆盖 `user` cell（官方渲染器在 `0`，优先级更低者胜出）；
2. 气泡本体仍调用官方的 `conversation.chat.user.content` factory，因此正文、附件、引用摘要、技能标签保持官方渲染；
3. 只自绘动作行：时间 + 撤回 + 复制，并沿用官方尺寸类与 `--dsw-alias-*` 主题令牌；
4. 撤回使用官方 `ctx.sessions.fork({ sessionId, atSeq })` 在目标消息前一个事件处截断（会话日志只追加不改写），打开新会话后用 `ctx.conversation.input.requestDraftInitialization` 回填原文；
5. 卸载时移除样式、语言包、计时器与槽位注册。

## 文件

| 文件 | 作用 |
| --- | --- |
| `client.js` | 浏览器端模块：槽位覆盖、动作行、撤回流 |
| `index.js` | Host 半边（空 apply，客户端负责全部行为） |
| `cordis.patch.yml` | bundle 层：插入插件行 |
| `locale/en.json`、`locale/zh.json` | Plugin Manager 展示标题与描述 |
| `icon.svg` | 插件图标（原创） |
| `smoke.mjs` | 工作区冒烟测试（模块形状 / 注册参数 / 单次渲染） |

## 已知边界

- 会话日志不可改写，因此"撤回"= 在目标消息前 fork 出一个新会话；旧会话归档而非删除。
- 当前轮次仍在生成时撤回键禁用（等待本轮结束），避免在未闭合回合上截断。
- 本会话的第一条消息没有可截断的前缀，撤回键禁用。
- 仅回填文本；消息中的图片 / 文件附件不会带回输入框。
- 需要在浏览器中刷新页面以载入新构建的客户端模块。

## 卸载

```sh
dsh plugin --profile web remove @local/dsh-message-recall
```
