# 任务台 · Hana × Super Productivity

任务台是一个 [Hana](https://github.com/liliMozi/openhanako) App，把 [Super Productivity](https://super-productivity.com/)（SP）接入 Hana 对话。SP 是唯一的任务记录源，Hana 通过工具读写它：任务、计划日与截止日、计时与补记工时、重复规则、笔记、计数器、归档与恢复。配合 SP 扩展后，还能管理项目和标签、排序、偏好、快捷键、链接附件、工作上下文和面板命令。

English: *Task Desk* connects Super Productivity to Hana chats. SP stays the single source of truth; Hana reads and writes it through tools. An optional SP plugin adds project/tag management, ordering, preferences, keyboard shortcuts, attachments and panel commands.

## 安装

1. 安装 SP 桌面版，在 SP 设置中开启本地 REST API（默认 `http://127.0.0.1:3876`）。
2. 在 Hana 的扩展市场安装「任务台」，或从本仓库 [Releases](https://github.com/shenmingganlin/hana-sp-tasks/releases) 下载 `app-sp-tasks-<版本>.zip`，通过 Hana 的扩展安装入口安装。安装时请审阅权限（见下文）。
3. 打开任务台设置页，顶部两行分别显示「本地接口」和「SP 扩展」是否连通。基础功能只需要第一行正常。
4. 需要扩展能力时，在设置页保存 SP 扩展包（也可直接下载 Release 中的 `hana-sp-bridge-<版本>.zip`），在 SP 的插件界面上传并启用，再在任务台设置页点「启用并显示配对码」，把配对码粘贴到 SP 插件的「配对 Hana」窗口。

也可以在 Hana 新对话中说「请使用任务台安装引导」，由助手按步骤检查和引导。

## 权限

| 权限 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 向对话提供任务工具 |
| `app/hooks.agent-pre-step` | 回答前注入一行待办摘要（60 秒缓存，SP 连不上时跳过） |
| `app/resources.read` | 读取 SP 的 REST 令牌文件和内置扩展包 |
| `app/resources.write` | 用户点击保存时把内置 SP 扩展包写到用户选择的位置 |
| `app/runtime.execute` / `app/runtime.native` / `app/runtime.network` | 运行桥接服务，只监听 `127.0.0.1:3877`，供 SP 扩展连接 |
| `app/ui.clipboard-write` | 用户点击复制配对码 |

网络出站只允许本机回环地址。桥接默认停用，用户在设置页配对后才启用。Windows 上桥接还需要 Hana 的 native sandbox 身份已初始化，首次启动约需一分钟。

## 目录

- `sp-tasks/`：Hana App 本体，没有构建步骤。`sdk/` 是随应用分发的 Hana SDK。
- `sp-hana-bridge/`：SP 扩展源码，`npm run build` 生成扩展 ZIP。`upstream-patches/` 是 SP 一处计数器持久化缺陷的独立补丁，未部署。
- `tests/sp-tasks/`：Node 内置测试，全部使用假 SP 和假 Hana SDK，不连接真实服务。

## 测试

需要 Node.js 24。先构建 SP 扩展（扩展测试会检查生成的 ZIP），再在仓库根目录运行测试：

```bash
node sp-hana-bridge/scripts/build.mjs
```

```bash
node --test $(ls tests/sp-tasks/*.mjs | grep -v -e /tools.mjs -e /mock-sp.mjs)
```

`tools.mjs` 需要真实运行的 SP，默认不包含。构建出的 `sp-hana-bridge/dist/hana-sp-bridge.zip` 与 `sp-tasks/assets/companion/` 中随应用分发的副本逐字节相同。

## 许可

MIT，见 [LICENSE](LICENSE)。`sp-tasks/sdk/` 来自 OpenHanako 项目，适用其自身许可。本项目不是 Super Productivity 或 Hana 的官方出品。
