# dsh-agent-change

dsh 桌面端的 Agent 预设（模式）切换插件。只为模式服务：

1. **每工作区默认模式**：不同项目的新会话可以落在不同模式上（如 P2P → standard、skills → ptc、nvim → minimal）。
2. **模式切换快捷键**：每个预设一条命令（默认 `⌘/Ctrl+Shift+1..9`，按清单顺序），外加一条"循环切换"（默认 `⌘/Ctrl+Shift+0`）；全部出现在 设置 → 快捷键 面板里，可逐个录制改键。默认键与既有命令冲突时插件自动降级为"未绑定"，不会抢占任何已占用的键。
3. **预设被删的自动回退**：引用已删预设的历史会话在核心 DSH 里会 `agent-preset/not-found` 打不开；本插件为其注册空占位预设（原 id 保留，会话能打开），会话打开时自动补写一条选设事件并切回**当前全局默认模式**。

## 适配版本

| 桌面端 DeepSeek Harness | 适配状态 |
|---|---|
| **0.2.1-rc.3** | ✅ 开发与实测通过的版本 |

- 引擎要求：`dsh >= 0.2.1-rc.3`（`package.json` → `dsh.engines`）。0.2.1-rc.2 及更早版本不再兼容（0.2.0 起改用 `sessionQuery.readSession` 与 Remote `{ok}` 信封语义）。
- 插件依赖不少**内部 API**（`agents` / `sessionProjections` 的 `turnBoundary`、`agentPreset` 投影，`settings.mutate`，`ctx.sessions.list` 行投影，`sessionQuery.readSession`，`conversation.input.left` 槽位等），桌面端大版本升级后若行为异常，优先核对这几处签名是否变化。

## 生效规则

- **模式锁定**是核心语义：会话一旦开始（有 turn）就不能换预设。快捷键/控件对已开始的会话只提示"已锁定"；空白会话立即生效。
- 工作区默认只在**用户没有显式选择**时应用（会话当前预设 == 全局默认才改写），不覆盖你在新会话选择器里的点选。
- 默认模式优先级：`<工作区>/.dsh/agent-preset.json` > 插件配置里的映射表 > 全局默认（设置 → Agent 预设）。
- 只处理根会话；subagent / fork 派生会话继承来源，不掺和。
- **删除工作区时其默认模式映射随之清理**：读取侧立即失效（映射只对仍注册的工作区生效），文件里的条目会在下次配置刷新/状态轮询时自动移除（残留条目不会影响 DSH 启动）。

## 项目级配置文件

在项目根放 `.dsh/agent-preset.json`（随 git 走、团队共享）：

```json
{ "preset": "ptc" }
```

也接受 `{"agentPreset": "…"}` 或纯字符串 `"ptc"`；空串表示跟随全局。可在插件配置里关掉 `projectFileOverrides`。

## 配置（设置 → 内置插件 → 模式切换；或插件页配置卡）

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspaceDefaults` | `{}` | 工作区绝对路径 → 预设 id |
| `projectFileOverrides` | `true` | 读取项目 `.dsh/agent-preset.json` |
| `autoRepair` | `true` | 预设被删后自动注册占位并在打开时回退（只读会话 header，廉价） |
| `deepScan` | `false` | 深度扫描：逐会话读日志查“切换后预设被删”的罕见场景，仅手动触发时生效，代价高 |

全部为 volatile 字段：改动持久化进当前 profile 的 `cordis.patch.yml`，即时生效。

## UI 落点

- 输入框工具行（模型选择器左侧）：当前模式徽章，点开切换预设 / 设为本项目默认。
- 插件页（本插件卡片内）：工作区 → 默认模式映射编辑器、autoRepair 开关、"立即扫描修复"按钮与占位清单。
- 设置 → 快捷键：搜索"切换到 / 模式 / agent"改键。

## 已知边界

- **内存**：自动扫描只读会话 header（不加载日志正文），并带 10 分钟节流与"清单未变化即跳过"；安装/配置重载连发事件也不会反复全量扫。扫描前会先等 Loader 树稳定（0.2.1 修复：启动窗口期用户 bundle 声明的预设尚未注册时会被误判为已删除并注册占位，导致随后打开/新建的会话被错误翻回全局默认）。深度扫描（`deepScan`）逐会话读日志、代价高，默认关闭，仅随"立即扫描修复"手动执行。
- 回退动作执行前会用 `agentPresets.resolve` 二次确认预设确实不存在（0.2.1 修复），预设被同名重建或清单短暂不完整时不再误翻会话。
- 占位预设与重建同名预设：若历史会话仍引用 `tutor` 时你重新安装同 id 预设，可能因占位占用 id 而注册失败；插件页"立即扫描修复"或重载该预设即可让位。
- 快捷键数字直达最多 9 个预设（超出部分仍可在快捷键面板手动绑定），第 10 个起只保留循环切换。
- 会话被手动切换到某预设后又删除该预设（非创建时绑定）的场景，header 扫描发现不了；需要时打开 `deepScan` 再点"立即扫描修复"。

## 结构

- `lib/index.js` — Host 半：工作区默认应用（`agent/created`）、占位守卫（`agentPresets.register` + `sessionQuery` 扫描）、`/api/dsh-agent-change/*` 桥。
- `lib/client.js` — Web 半：快捷键命令注册（`ctx.shortcuts`）、输入框模式徽章、插件页映射编辑器、Toast。
- 安装：DeepSeek Harness → 插件 → 从文件夹安装，或 `plugin_manager install_bundle`（指向本目录）。
