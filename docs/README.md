# DSH Message Recall 使用文档

[返回项目首页](<../README.md>)

## 安装

先安装并运行 DSH Web；插件声明兼容 DSH `>=0.2.1-rc.3`。在运行 Web 的 profile 中安装，`web` 可替换为实际 profile 名：

```sh
dsh plugin --profile web add @kaus-io/dsh-message-recall@1.0.0-alpha01
```

安装后刷新页面；若宿主提示需要重启，按提示重载。

若要从源码开发，克隆本仓库并构建，然后在 DSH 插件管理中安装本地组合包：

```sh
git clone https://github.com/kaus-io/dsh-message-recall.git
cd dsh-message-recall
pnpm install
pnpm run build
```

```text
link:/绝对路径/dsh-message-recall
```

npm 与本地链接二选一，替换前先移除旧来源。仓库已包含运行产物，使用时无需先构建。本地链接依赖仓库目录，移动或删除会影响插件。

## 快速使用

1. 等待当前回复结束，在要修改的用户消息下方、复制键旁点击 **↺ 撤回**。较早消息的操作栏在悬停或获得焦点时显示。
2. 查看确认提示，选择**确定**；取消则保持原会话不变。提示会列出受影响的后续提问数量。
3. 插件打开保留此前上下文的新会话，并将这条消息的文本放回输入框。
4. 修改文本，按需重新添加附件后发送。旧会话会尝试自动归档，仍可从侧栏归档区找回。

## 行为与限制

- **撤回不是删除记录**：它在目标消息之前分叉出新会话；目标消息及后续问答不进入新分支，旧会话日志保留。
- **不会撤销已经执行的操作**：文件改动、命令、外部服务调用等副作用不会随对话回退。
- 当前会话仍在生成时不可撤回；第一条消息没有可保留的前缀，也不可撤回。
- 仅回填文本，图片与文件附件不会自动带回输入框。
- 需要宿主提供会话分叉权限；没有权限时不显示撤回按钮。
- 插件接管用户消息的渲染入口，和同样替换该入口的插件可能冲突。

## 卸载

可在插件管理中卸载；使用命令行时，将 `web` 替换为实际安装的 profile：

```sh
dsh plugin --profile web remove @kaus-io/dsh-message-recall
```

## 开发与验证

在本仓库目录执行：

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

`pnpm test` 会先编译工具与测试脚本，再检查提交产物是否与源码一致、运行版本脚本测试，并执行客户端 smoke。工具与测试脚本以 TypeScript 写在 `*.ts`，`pnpm run build:tools` 用 esbuild 编译成同名 `.mjs` 后再执行；生成的 `.mjs` 不入库。

报告问题时，请提供 DSH 版本、复现步骤及已脱敏的错误信息。交互参考了 [opencode](https://github.com/anomalyco/opencode) 的回退体验，以及 [DSH-EasyRewrite](https://github.com/Renzic-Stone/DSH-EasyRewrite) 的按钮位置。
