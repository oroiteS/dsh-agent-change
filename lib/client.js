// dsh-agent-change — Client half（浏览器端）。
//
// 职责（全部只为模式服务）：
// 1. 快捷键：为每个预设注册一条命令（默认 ⌘/Ctrl+Shift+1..9，按清单顺序），
//    外加一条"循环切换"命令（默认 ⌘/Ctrl+Shift+0）。命令出现在设置 → 快捷键
//    面板里，用户可逐个改键；注册时默认键与既有命令冲突会抛错，此时降级为
//    "未绑定"（仍可在面板里手动绑定）。会话已开始（模式锁定）时仅提示。
// 2. 输入框工具行控件（conversation.input.left）：显示当前会话模式，点开
//    弹出预设列表可切换（空白会话），并支持"设为本项目默认"。
// 3. 插件页配置卡（plugins.bundle.config）：工作区 → 默认模式映射编辑器 +
//    回退占位状态 + 手动修复按钮。
// 4. Toast（shell.overlay）：切换成功/失败/锁定的轻提示。
//
// 与 Host 半的全部通信走同源 fetch /api/dsh-agent-change/*（回环守护）；
// 配置写入走 ctx.remote.settings.update("agent-change", …)（volatile 字段，
// 持久化进 profile 的 cordis.patch.yml）。
window.__ModuleLoader__.load({
	id: "dsh-agent-change",
	factory(require) {
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const ENTRY_ID = "agent-change";
		const API = "/api/dsh-agent-change";
		const SHORTCUT_PROFILES = ["desktop:macos", "desktop:windows", "desktop:linux", "web:macos", "web:windows"];

		const LOCALE = {
			zh: {
				switchTo: "切换到",
				cycle: "切换到下一个模式",
				already: "当前已是该模式",
				switched: "已切换：",
				switchFailed: "切换失败：",
				locked: "会话已开始，模式已锁定（如需换模式请新建会话）",
				workspaceDefaultSet: "已设为项目默认模式",
				workspaceDefaultCleared: "已恢复跟随全局默认",
				setAsProjectDefault: "设为本项目默认",
				saveAsDefault: "保存为默认设置",
				restoreGlobal: "恢复跟随全局默认",
				followGlobal: "跟随全局默认",
				projectDefault: "项目默认",
				missing: "已移除",
				noPreset: "无预设",
				globalDefault: "全局默认",
				blank: "空白",
				started: "已开始",
				mapperTitle: "工作区 → 默认模式",
				mapperIntro: "为每个工作区选择新会话的默认模式（仅在用户没有显式选择时生效）；项目下 .dsh/agent-preset.json 优先级更高。",
				mapperSave: "保存",
				mapperReset: "还原",
				mapperSaved: "已保存工作区默认模式",
				mapperSaveFailed: "保存失败：",
				mapperEmpty: "还没有工作区。",
				autoRepair: "预设被删后自动回退（占位 + 打开时切回默认）",
				deepScan: "深度扫描（逐会话读日志，代价高；只查“切换后预设被删”的罕见场景）",
				repairNow: "立即扫描修复",
				repairDone: "扫描完成：当前占位 {n} 个",
				repairFailed: "扫描失败：",
				placeholders: "回退占位：",
				noPlaceholders: "无",
				realmHint: "快捷键：设置 → 快捷键 里搜索“切换到 / 模式”可逐个改键。",
			},
			en: {
				switchTo: "Switch to ",
				cycle: "Cycle to next mode",
				already: "Already the current mode",
				switched: "Switched: ",
				switchFailed: "Switch failed: ",
				locked: "Session already started; its mode is locked (start a new session to change)",
				workspaceDefaultSet: "Set as the project default mode",
				workspaceDefaultCleared: "Now following the global default",
				setAsProjectDefault: "Set as project default",
				saveAsDefault: "Save as project default",
				restoreGlobal: "Restore global default",
				followGlobal: "Follow global default",
				projectDefault: "project default",
				missing: "removed",
				noPreset: "No preset",
				globalDefault: "global default",
				blank: "blank",
				started: "started",
				mapperTitle: "Workspace → default mode",
				mapperIntro: "Pick the default mode for new sessions per workspace (applies only when no explicit choice was made); <workspace>/.dsh/agent-preset.json takes precedence.",
				mapperSave: "Save",
				mapperReset: "Revert",
				mapperSaved: "Workspace defaults saved",
				mapperSaveFailed: "Save failed: ",
				mapperEmpty: "No workspaces yet.",
				autoRepair: "Auto-fallback when a preset is deleted (placeholder + switch back on open)",
				deepScan: "Deep scan (reads every session log; costly; only finds “switched to a preset deleted later”)",
				repairNow: "Scan & repair now",
				repairDone: "Scan finished: {n} placeholder(s)",
				repairFailed: "Scan failed: ",
				placeholders: "Placeholders: ",
				noPlaceholders: "none",
				realmHint: "Shortcuts: rename any of them in Settings → Keyboard shortcuts (search “Switch to”).",
			},
		};

		function apply(ctx) {
			//#region locale
			try {
				ctx.locale.register("agent-change", { zh: LOCALE.zh, en: LOCALE.en });
			} catch {
				for (const [locale, dict] of Object.entries(LOCALE)) {
					try {
						ctx.locale.register("agent-change", locale, dict);
					} catch {}
				}
			}
			const t = (key, params) => {
				try {
					const text = ctx.locale.bind("agent-change")(key);
					return typeof text === "string" && params ? text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : typeof text === "string" ? text : key;
				} catch {
					return key;
				}
			};
			//#endregion

			//#region 样式（一次性注入，卸载时移除；只引用 --dsw-alias-* 主题变量）
			const CSS = `
.dshac-badge{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;max-width:180px}
.dshac-badge:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dshac-badge-name{overflow:hidden;text-overflow:ellipsis}
.dshac-caret{font-size:9px;opacity:.7}
.dshac-pop{position:absolute;top:28px;left:0;z-index:60;min-width:230px;max-width:300px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.28)}
.dshac-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;text-align:left;cursor:pointer}
.dshac-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dshac-row[disabled]{opacity:.45;cursor:default}
.dshac-row-check{width:14px;text-align:center;color:var(--dsw-alias-brand-primary)}
.dshac-row-key{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dshac-sep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l1)}
.dshac-tag{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dshac-hint{padding:4px 8px 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dshac-toast-wrap{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.dshac-toast{max-width:520px;padding:8px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12.5px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
.dshac-toast[data-kind="success"]{border-color:var(--dsw-alias-state-success-primary)}
.dshac-toast[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.dshac-toast[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary)}
.dshac-mapper{display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--dsw-alias-label-primary);min-width:0;max-width:100%}
.dshac-mapper-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;flex-wrap:wrap;min-width:0}
.dshac-mapper-path{flex:1 1 150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dshac-mapper-title{font-weight:600;white-space:nowrap}
.dshac-mapper select{max-width:190px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 8px}
.dshac-mapper button{font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 8px}
.dshac-mapper button:hover{border-color:var(--dsw-alias-border-l2)}
.dshac-mapper button:disabled{opacity:.5;cursor:default}
.dshac-mapper button{cursor:pointer}
.dshac-mapper button:hover{border-color:var(--dsw-alias-border-l2)}
.dshac-mapper-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshac-mapper-status{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dshac-checkline{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-secondary)}
.dshac-badge-wrap{position:relative;display:inline-flex}
`;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "agent-change: styles");
			//#endregion

			//#region 状态缓存与数据访问
			let stateCache = null;
			let stateAt = 0;
			let shortcutSyncQueued = false;

			async function fetchState(sessionId, force) {
				const now = Date.now();
				if (!force && stateCache && now - stateAt < 30000 && (!sessionId || stateCache.session?.sessionId === sessionId)) return stateCache;
				const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
				const response = await fetch(`${API}/state${query}`, { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.json();
				if (data?.ok) {
					stateCache = data;
					stateAt = now;
					queueShortcutSync();
				}
				return data;
			}

			function mainSessionId() {
				try {
					const snapshot = ctx.sessions?.list?.getSnapshot?.();
					const byId = snapshot?.byId ?? {};
					for (const row of Object.values(byId)) {
						if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id;
					}
				} catch {}
				return undefined;
			}

			function sortedPresets(state) {
				return (state?.presets ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
			}
			function presetLabel(state, id) {
				const found = (state?.presets ?? []).find((item) => item.id === id);
				return found?.name ?? found?.id ?? id;
			}
			function currentOf(state) {
				return state?.session?.current ?? state?.defaultId ?? undefined;
			}
			/** 客户端会话列表行（与原生模式选择器同一数据源，随投影帧实时更新）。 */
			function sessionRow(sessionId) {
				try {
					const snapshot = ctx.sessions?.list?.getSnapshot?.();
					return snapshot?.byId?.[sessionId] ?? undefined;
				} catch {
					return undefined;
				}
			}
			/** 行投影里记录的预设 id（string；未显式选择过的会话为 null/缺失）。 */
			function rowPreset(row) {
				const value = row?.projectionValues?.agentPreset;
				return typeof value === "string" ? value : undefined;
			}
			/** 当前模式的统一取值：优先实时行投影，回落到服务端快照。 */
			function currentPreset(sessionId, state) {
				return rowPreset(sessionRow(sessionId)) ?? currentOf(state);
			}
			//#endregion

			//#region Toast（shell.overlay）
			let notifyRef = null;
			let toastSeq = 0;
			function notify(text, kind) {
				try {
					notifyRef?.(text, kind ?? "info");
				} catch {}
			}
			function ToastHost() {
				const [items, setItems] = useState([]);
				useEffect(() => {
					notifyRef = (text, kind) => {
						const id = ++toastSeq;
						setItems((list) => [...list.slice(-3), { id, text, kind }]);
						setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 3400);
					};
					return () => {
						notifyRef = null;
					};
				}, []);
				return h(
					"div",
					{ className: "dshac-toast-wrap" },
					items.map((item) => h("div", { key: item.id, className: "dshac-toast", "data-kind": item.kind }, item.text)),
				);
			}
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "agent-change-toast", order: 940 }, ToastHost));
			//#endregion

			//#region 模式切换执行
			/** rc.3 起 Remote 失败以 {ok:false, error} 信封 resolve（error 为 RemoteError：code/details/message）。 */
			function errorCodeOf(error) {
				return error?.code ?? error?.details?.code ?? error?.data?.code ?? (typeof error?.message === "string" ? error.message : String(error));
			}
			/** 统一解包 Remote 结果：业务失败转成带 code 的错误抛出，传输层异常原样透传。 */
			function unwrapRemote(result, fallbackMessage) {
				if (result && typeof result === "object" && result.ok === false) {
					const error = result.error ?? {};
					const failure = new Error(typeof error.message === "string" && error.message ? error.message : fallbackMessage);
					failure.code = error.code ?? error.details?.code;
					failure.details = error.details;
					throw failure;
				}
				return result;
			}

			async function performSwitch(sessionId, presetId, state) {
				const label = presetLabel(state, presetId);
				// 空白判定优先用客户端实时行（与原生 UI 同源）；服务端只在明确说“已开始”时
				// 才拦截，unknown 时放行——由宿主 agentPresets.select 的权威锁定检查兜底。
				const rowBlank = sessionRow(sessionId)?.blank;
				const serverBlank = state?.session?.blank;
				if (rowBlank === false || serverBlank === false) {
					notify(t("locked"), "warn");
					return;
				}
				if (state && currentPreset(sessionId, state) === presetId) {
					notify(t("already"), "info");
					return;
				}
				try {
					const result = await ctx.remote?.agentPresets?.select?.(sessionId, presetId);
					// rc.3：宿主拒绝（agent-preset/locked 等）走 {ok:false} 信封，不会抛异常。
					if (result && typeof result === "object" && result.ok === false) {
						const code = String(errorCodeOf(result.error) || "unknown");
						if (/locked/i.test(code)) notify(t("locked"), "warn");
						else notify(`${t("switchFailed")}${label}（${code}）`, "error");
					} else {
						notify(`${t("switched")}${label}`, "success");
					}
				} catch (error) {
					const code = String(errorCodeOf(error));
					if (/locked/i.test(code)) notify(t("locked"), "warn");
					else notify(`${t("switchFailed")}${label}（${code}）`, "error");
				}
				fetchState(sessionId, true).catch(() => {});
			}

			function switchResolve(presetId) {
				return () => {
					const sessionId = mainSessionId();
					if (!sessionId) return { status: "ignored" };
					return {
						status: "handled",
						run: () => {
							fetchState(sessionId, true)
								.catch(() => null)
								.then((state) => performSwitch(sessionId, presetId, state));
						},
					};
				};
			}
			//#endregion

			//#region 快捷键：每预设一条 + 循环切换
			let shortcutDisposers = [];
			let lastShortcutSignature = "";

			function defaultsWithDigit(digit) {
				const defaults = {};
				for (const profile of SHORTCUT_PROFILES) defaults[profile] = { code: `Digit${digit}`, modifiers: ["primary", "shift"] };
				return defaults;
			}

			function registerCommandSafely(definition) {
				try {
					return ctx.shortcuts.register(definition);
				} catch {
					// 默认键冲突：降级为未绑定，仍出现在快捷键面板里供手动绑定。
					try {
						return ctx.shortcuts.register({ ...definition, defaults: {} });
					} catch {
						return undefined;
					}
				}
			}

			function syncShortcuts(state) {
				if (!ctx.shortcuts) return;
				// 清单没变就不重注册：register/dispose 循环每分钟跑一次是无谓的抖动。
				const signature = [
					state?.defaultId ?? "",
					...sortedPresets(state).map((item) => `${item.id}:${item.order ?? 0}`),
					`p${(state?.placeholders ?? []).length}`,
				].join("|");
				if (signature === lastShortcutSignature) return;
				lastShortcutSignature = signature;
				for (const dispose of shortcutDisposers) {
					try {
						dispose?.();
					} catch {}
				}
				shortcutDisposers = [];
				const presets = sortedPresets(state);
				const placeholders = new Set((state?.placeholders ?? []).map((item) => item.id));
				presets.slice(0, 9).forEach((preset, index) => {
					shortcutDisposers.push(
						registerCommandSafely({
							id: `agent-change.preset.${preset.id}`,
							label: () => `${t("switchTo")}${preset.name ?? preset.id}`,
							aliases: ["agent preset", "mode", preset.name, preset.id].filter((value) => typeof value === "string"),
							defaults: index < 9 ? defaultsWithDigit(index + 1) : {},
							regions: ["page", "editable"],
							modals: [],
							resolve: switchResolve(preset.id),
						}),
					);
				});
				shortcutDisposers.push(
					registerCommandSafely({
						id: "agent-change.preset.cycle",
						label: () => t("cycle"),
						aliases: ["next mode", "cycle mode", "agent preset"],
						defaults: defaultsWithDigit(0),
						regions: ["page", "editable"],
						modals: [],
						resolve: () => {
							const sessionId = mainSessionId();
							if (!sessionId) return { status: "ignored" };
							return {
								status: "handled",
								run: () => {
									fetchState(sessionId, true)
										.catch(() => null)
										.then((state) => {
											if (!state) return;
											const presets = sortedPresets(state).filter((item) => !placeholdersFrom(state).has(item.id));
											if (presets.length === 0) return;
											const current = currentPreset(sessionId, state);
											const at = presets.findIndex((item) => item.id === current);
											const next = presets[(at + presets.length + 1) % presets.length] ?? presets[0];
											performSwitch(sessionId, next.id, state);
										});
								},
							};
						},
					}),
				);
			}

			function placeholdersFrom(state) {
				return new Set((state?.placeholders ?? []).map((item) => item.id));
			}

			function queueShortcutSync() {
				if (shortcutSyncQueued) return;
				shortcutSyncQueued = true;
				Promise.resolve().then(() => {
					shortcutSyncQueued = false;
					syncShortcuts(stateCache);
				});
			}

			ctx.effect(() => {
				// 轮询只刷新清单/配置，不带 sessionId：服务端对冷会话查当前模式要走会话清单，没必要每分钟做。
				const interval = setInterval(() => {
					fetchState().catch(() => {});
				}, 60000);
				const onFocus = () => {
					fetchState().catch(() => {});
				};
				window.addEventListener("focus", onFocus);
				fetchState(mainSessionId()).catch(() => {});
				return () => {
					clearInterval(interval);
					window.removeEventListener("focus", onFocus);
					for (const dispose of shortcutDisposers) {
						try {
							dispose?.();
						} catch {}
					}
					shortcutDisposers = [];
				};
			}, "agent-change: shortcuts + roster refresh");
			//#endregion

			//#region 配置写入（settings volatile 字段 → profile patch）
			function patchMatches(data, patch) {
				if (!data?.ok) return false;
				for (const [key, value] of Object.entries(patch)) {
					if (key === "workspaceDefaults") {
						if (JSON.stringify(data?.config?.workspaceDefaults ?? {}) !== JSON.stringify(value ?? {})) return false;
					} else if (data?.config?.[key] !== value) return false;
				}
				return true;
			}

			/** 写入会触发本条目热重载（旧代次路由 → 新代次路由），/state 短暂返回旧配置甚至 404：
			 *  轮询直到新代次把写入值报回来；超时抛错——绝不能静默成功，否则 UI 会弹假“已保存”。 */
			async function pollConfigMatch(patch) {
				for (let attempt = 0; attempt < 12; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 400));
					try {
						const data = await fetchState(mainSessionId(), true);
						if (patchMatches(data, patch)) return;
					} catch {}
				}
				throw new Error("config write did not settle in time");
			}

			async function writeConfig(patch) {
				// 远端按参数个数严格校验：expectedRevision 传 undefined = 无条件写入。
				// rc.3：业务失败以 {ok:false} 信封 resolve，必须显式解包，否则会静默假成功。
				unwrapRemote(await ctx.remote?.settings?.update?.(ENTRY_ID, patch, undefined), "settings update failed");
				await pollConfigMatch(patch);
			}

			/**
			 * 工作区映射写入：settings.update 对 dict 深合并、删不掉已有 key（“恢复跟随全局默认”
			 * 会假成功），增删改统一走 settings.mutate 的路径操作（unset 才是真正的删除）。
			 */
			async function writeWorkspaceDefaults(base, next) {
				const ops = [];
				for (const [key, value] of Object.entries(base ?? {})) {
					if (!Object.hasOwn(next, key)) ops.push({ op: "unset", path: ["workspaceDefaults", key] });
					else if (next[key] !== value) ops.push({ op: "set", path: ["workspaceDefaults", key], value: next[key] });
				}
				for (const [key, value] of Object.entries(next)) {
					if (!Object.hasOwn(base ?? {}, key)) ops.push({ op: "set", path: ["workspaceDefaults", key], value });
				}
				if (!ops.length) return;
				unwrapRemote(await ctx.remote?.settings?.mutate?.(ENTRY_ID, ops, undefined), "settings mutate failed");
				await pollConfigMatch({ workspaceDefaults: next });
			}
			//#endregion

			//#region 输入框工具行控件
			function bindingHint(presetId) {
				try {
					const rows = ctx.shortcuts?.catalog?.getSnapshot?.() ?? [];
					const row = rows.find((item) => item.id === `agent-change.preset.${presetId}`);
					return Array.isArray(row?.keys) && row.keys.length > 0 ? row.keys.join("") : "";
				} catch {
					return "";
				}
			}

			function PresetBadge(props) {
				const sessionId = props?.sessionId ?? mainSessionId();
				const [state, setState] = useState(stateCache);
				const [open, setOpen] = useState(false);
				const rootRef = useRef(null);
				// 实时行订阅：原生切换（或其他面板切换）后徽章立即跟上，修复显示不刷新。
				const [row, setRow] = useState(() => sessionRow(sessionId));
				useEffect(() => {
					setRow(sessionRow(sessionId));
					const store = ctx.sessions?.list;
					if (typeof store?.subscribe !== "function") return undefined;
					const update = () => setRow(sessionRow(sessionId));
					try {
						return store.subscribe(update);
					} catch {
						return undefined;
					}
				}, [sessionId]);
				useEffect(() => {
					let alive = true;
					if (!sessionId) return undefined;
					fetchState(sessionId)
						.then((data) => {
							if (alive) setState(data);
						})
						.catch(() => {});
					return () => {
						alive = false;
					};
				}, [sessionId, open]);
				useEffect(() => {
					if (!open) return undefined;
					const onKey = (event) => {
						if (event.key === "Escape") setOpen(false);
					};
					const onDown = (event) => {
						if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
					};
					document.addEventListener("keydown", onKey, true);
					document.addEventListener("mousedown", onDown, true);
					return () => {
						document.removeEventListener("keydown", onKey, true);
						document.removeEventListener("mousedown", onDown, true);
					};
				}, [open]);
				if (!sessionId) return null;
				const current = rowPreset(row) ?? currentOf(state);
				const currentLabel = current ? presetLabel(state, current) : t("noPreset");
				const placeholders = placeholdersFrom(state);
				const mapped = state?.mappedDefault;
				const projectDefault = state?.projectFileDefault;
				const presets = sortedPresets(state);
				return h(
					"div",
					{ className: "dshac-badge-wrap", ref: rootRef },
					h(
						"button",
						{
							className: "dshac-badge",
							type: "button",
							title: `${currentLabel}${mapped ? ` · ${t("projectDefault")}` : ""}`,
							onClick: () => setOpen((value) => !value),
						},
						h("span", { className: "dshac-badge-name" }, currentLabel),
						mapped ? h("span", { className: "dshac-tag" }, "●") : null,
						h("span", { className: "dshac-caret" }, open ? "▲" : "▼"),
					),
					open
						? h(
								"div",
								{ className: "dshac-pop" },
								presets.map((preset) =>
									h(
										"button",
										{
											key: preset.id,
											className: "dshac-row",
											type: "button",
											disabled: placeholders.has(preset.id),
											onClick: () => {
												setOpen(false);
												performSwitch(sessionId, preset.id, state);
											},
										},
										h("span", { className: "dshac-row-check" }, preset.id === current ? "✓" : ""),
										h("span", null, preset.name ?? preset.id),
										placeholders.has(preset.id) ? h("span", { className: "dshac-tag" }, t("missing")) : null,
										preset.id === projectDefault || preset.id === mapped ? h("span", { className: "dshac-tag" }, t("projectDefault")) : null,
										(() => {
											const keys = bindingHint(preset.id);
											return keys ? h("span", { className: "dshac-row-key" }, keys) : null;
										})(),
									),
								),
								h("div", { className: "dshac-sep" }),
								h(
									"button",
									{
										className: "dshac-row",
										type: "button",
										disabled: !current,
										title: current ? `${t("saveAsDefault")}：${presetLabel(state, current)}` : t("noPreset"),
										onClick: () => {
											const path = state?.workspace?.path;
											setOpen(false);
											if (!path || !current) return;
											writeWorkspaceDefaults(state?.config?.workspaceDefaults ?? {}, mergeMap(state, path, current))
												.then(() => notify(`${t("workspaceDefaultSet")}：${presetLabel(state, current)}`, "success"))
												.catch((error) => notify(`${t("mapperSaveFailed")}${errorCodeOf(error)}`, "error"));
										},
									},
									h("span", { className: "dshac-row-check" }, ""),
									h("span", null, t("saveAsDefault")),
								),
								mapped
									? h(
											"button",
											{
												className: "dshac-row",
												type: "button",
												title: `${t("restoreGlobal")}（${t("projectDefault")}：${presetLabel(state, mapped)}）`,
												onClick: () => {
													const path = state?.workspace?.path;
													setOpen(false);
													if (!path) return;
													writeWorkspaceDefaults(state?.config?.workspaceDefaults ?? {}, mergeMap(state, path, undefined))
														.then(() => notify(t("workspaceDefaultCleared"), "success"))
														.catch((error) => notify(`${t("mapperSaveFailed")}${errorCodeOf(error)}`, "error"));
												},
											},
											h("span", { className: "dshac-row-check" }, ""),
											h("span", null, t("restoreGlobal")),
										)
									: null,
								h("div", { className: "dshac-hint" }, `${(row?.blank ?? state?.session?.blank) === false ? t("started") : t("blank")} · ${t("realmHint")}`),
						  )
						: null,
				);
			}

			function mergeMap(state, path, presetId) {
				const map = { ...(state?.config?.workspaceDefaults ?? {}) };
				if (presetId) map[path] = presetId;
				else delete map[path];
				return map;
			}

			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register({
					name: "conversation.input.left",
					id: "agent-change",
					order: 2,
					inject: (sessionId) => ({ sessionId }),
				}, PresetBadge),
			);
			//#endregion

			//#region 插件页配置卡：工作区 → 默认模式 + 回退占位
			function WorkspaceMapper() {
				const [workspaces, setWorkspaces] = useState(null);
				const [state, setState] = useState(null);
				const [map, setMap] = useState({});
				const [status, setStatus] = useState("");
				const [repairing, setRepairing] = useState(false);
				const load = useCallback(() => {
					fetch("/api/dsh-agent-change/workspaces", { headers: { accept: "application/json" } })
						.then((response) => response.json())
						.then((data) => setWorkspaces(Array.isArray(data?.workspaces) ? data.workspaces : []))
						.catch(() => setWorkspaces([]));
					fetchState(mainSessionId(), true)
						.then((data) => {
							setState(data);
							setMap({ ...(data?.config?.workspaceDefaults ?? {}) });
						})
						.catch(() => {});
				}, []);
				useEffect(load, [load]);
				const dirty = state ? JSON.stringify(map) !== JSON.stringify(state?.config?.workspaceDefaults ?? {}) : false;
				const presets = sortedPresets(state);
				const placeholders = state?.placeholders ?? [];
				const autoRepair = state?.config?.autoRepair !== false;
				const deepScan = state?.config?.deepScan === true;
				return h(
					"div",
					{ className: "dshac-mapper" },
					h("div", null, t("mapperIntro")),
					workspaces === null
						? h("div", { className: "dshac-mapper-status" }, "…")
						: workspaces.length === 0
							? h("div", { className: "dshac-mapper-status" }, t("mapperEmpty"))
							: workspaces.map((workspace) =>
									h(
										"div",
										{ key: workspace.id || workspace.path, className: "dshac-mapper-row" },
										h("span", { className: "dshac-mapper-title" }, workspace.title),
										h("span", { className: "dshac-mapper-path" }, workspace.path),
										h(
											"select",
											{
												value: map[workspace.path] ?? "",
												onChange: (event) => {
													const value = event.target.value;
													setMap((previous) => {
														const next = { ...previous };
														if (value) next[workspace.path] = value;
														else delete next[workspace.path];
														return next;
													});
												},
											},
											h("option", { value: "" }, t("followGlobal")),
											presets.map((preset) => h("option", { key: preset.id, value: preset.id }, preset.name ?? preset.id)),
										),
									),
							  ),
					h(
						"div",
						{ className: "dshac-mapper-actions" },
						h(
							"button",
							{
								type: "button",
								disabled: !dirty,
								onClick: () => {
									writeWorkspaceDefaults(state?.config?.workspaceDefaults ?? {}, map)
										.then(() => {
											setStatus(t("mapperSaved"));
											load();
										})
										.catch((error) => setStatus(`${t("mapperSaveFailed")}${errorCodeOf(error)}`));
								},
							},
							t("mapperSave"),
						),
						h("button", { type: "button", disabled: !dirty, onClick: () => setMap({ ...(state?.config?.workspaceDefaults ?? {}) }) }, t("mapperReset")),
						h("span", { className: "dshac-mapper-status" }, status),
					),
					h("div", { className: "dshac-sep" }),
					h(
						"label",
						{ className: "dshac-checkline" },
						h("input", {
							type: "checkbox",
							checked: autoRepair,
							onChange: (event) => {
								const next = event.target.checked;
								writeConfig({ autoRepair: next }).catch((error) => setStatus(`${t("mapperSaveFailed")}${errorCodeOf(error)}`));
							},
						}),
						t("autoRepair"),
					),
					h(
						"label",
						{ className: "dshac-checkline" },
						h("input", {
							type: "checkbox",
							checked: deepScan,
							onChange: (event) => {
								const next = event.target.checked;
								writeConfig({ deepScan: next }).catch((error) => setStatus(`${t("mapperSaveFailed")}${errorCodeOf(error)}`));
							},
						}),
						t("deepScan"),
					),
					h(
						"div",
						{ className: "dshac-mapper-actions" },
						h(
							"button",
							{
								type: "button",
								disabled: repairing,
								onClick: () => {
									setRepairing(true);
									fetch(`${API}/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
										.then((response) => response.json())
										.then((data) => {
											setStatus(t("repairDone", { n: Array.isArray(data?.placeholders) ? data.placeholders.length : 0 }));
											load();
										})
										.catch((error) => setStatus(`${t("repairFailed")}${errorCodeOf(error)}`))
										.finally(() => setRepairing(false));
								},
							},
							t("repairNow"),
						),
						h(
							"span",
							{ className: "dshac-mapper-status" },
							`${t("placeholders")}${placeholders.length === 0 ? t("noPlaceholders") : placeholders.map((item) => `${item.id}×${item.sessions}`).join("、")}`,
						),
					),
				);
			}

			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-agent-change" }, WorkspaceMapper));
			//#endregion
		}

		return {
			inject: ["slots", "shortcuts", "remote", "remote.agentPresets", "remote.settings", "sessions", "locale"],
			apply,
		};
	},
});
