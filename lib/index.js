// dsh-agent-change — Host half.
//
// 两个核心能力（均为"模式服务"，不触碰其他领域）：
//
// 1. 每工作区默认模式：新会话创建时（agent/created），若该会话
//    - 是根会话（非 subagent/fork 派生），
//    - 仍运行全局默认预设（说明用户没有显式选择模式），
//    - 且其工作区配置了项目级默认预设，
//    则用 agentPresets.select() 提交该预设（空白会话才允许，select 自带锁定检查）。
//    优先级：项目文件 <工作区>/.dsh/agent-preset.json > 插件配置里的映射表。
//
// 2. 预设被删后的自动回退：DSH 核心对"会话日志记录的预设已不存在"没有任何
//    回退（resolve 抛 agent-preset/not-found，会话打不开）。本插件扫描全部
//    会话引用的预设 id，为缺失者注册一个空插件占位预设（原 id 保留，会话能
//    打开）；当这种会话真正加载（agent/created 且当前预设是占位）时，补写
//    一条 agent-preset/selected 事件并 recompose 到当前全局默认——之后该会话
//    永久落在默认模式上。
//
// HTTP 桥（同源 + 回环守护，路径 /api/dsh-agent-change/*）：
//   GET  /state?sessionId=…   会话/工作区/预设清单的一次性快照（给 client 半）
//   GET  /workspaces          工作区注册表投影（路径、标题）
//   POST /repair              手动触发占位扫描，返回摘要
import { readFile } from "node:fs/promises";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

const ENTRY_ID = "agent-change";
const API_PREFIX = "/api/dsh-agent-change";
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** 插件配置：全部 volatile——设置页可编辑，写入当前 profile 的 cordis.patch.yml。 */
export const Config = z.object({
	// 工作区绝对路径 → 预设 id；空串/缺省视为跟随全局默认。
	workspaceDefaults: z.dict(z.string()).default({}).volatile(),
	// 是否读取项目级 <工作区>/.dsh/agent-preset.json（{"preset": "..."} 或纯字符串）。
	projectFileOverrides: z.boolean().default(true).volatile(),
	// 预设被删后自动注册回退占位并在会话打开时切回默认。
	// 自动扫描只读会话 header（廉价、不加载日志正文）；深度事件扫描代价高，仅手动且此项开启时执行。
	autoRepair: z.boolean().default(true).volatile(),
	deepScan: z.boolean().default(false).volatile(),
});

export function apply(ctx, config) {
	// 所有依赖服务缺失时整体不激活（与 dsh-session-delete 同策略），避免半工作状态。
	// 注意 agents / sessionProjections 必须显式注入：Cordis 对未注入的服务
	// 属性访问直接抛 "cannot get property ... without inject"（而不是返回
	// undefined），否则 live 判定永远失败，冷路径兜底会把所有会话误判为"已开始"。
	// settings 用于把"已删除工作区的默认模式映射清理"写回 profile（与设置页同一通道）。
	// loader 用于扫描前等待 Loader 树稳定：用户 bundle 声明的预设（tutor/superpowers 等）
	// 在启动窗口期可能尚未注册，拿不完整清单对照会话 header 会把活预设误判成已删除。
	ctx.inject(["agentPresets", "sessionQuery", "webServer", "workspaceRegistry", "agents", "sessionProjections", "settings", "loader"], (sctx) => {
		const presets = sctx.agentPresets;
		const log = sctx.logger ?? console;

		//#region 配置读取
		/**
		 * volatile 字段经 loader 解析后不是普通值，而是 cosmokit createVolatile 包装的
		 * 冻结引用对象 {get}（loader 的 volatile-only 热更新就靠就地改写它的内部快照）。
		 * 直接把引用当 map/boolean 用会读出空值——这里统一解引用取当前快照，
		 * 同时兼容普通值（未走 schemastery 解析的调用路径）。
		 */
		function volatileValue(value, fallback) {
			if (value !== null && typeof value === "object" && typeof value.get === "function") {
				try {
					value = value.get();
				} catch {
					value = undefined;
				}
			}
			return value === undefined || value === null ? fallback : value;
		}

		const cfg = () => {
			const raw = config ?? {};
			const defaults = volatileValue(raw.workspaceDefaults, {});
			return {
				workspaceDefaults: defaults && typeof defaults === "object" ? defaults : {},
				projectFileOverrides: volatileValue(raw.projectFileOverrides, true) !== false,
				autoRepair: volatileValue(raw.autoRepair, true) !== false,
				deepScan: volatileValue(raw.deepScan, false) === true,
			};
		};

		/** 当前注册工作区的路径集合（trailing-slash 归一；映射只对注册工作区生效）。 */
		function registeredPaths() {
			const paths = new Set();
			try {
				for (const workspace of sctx.workspaceRegistry.list()) {
					if (typeof workspace?.path === "string" && workspace.path) {
						const normalized = workspace.path.replace(/\/+$/, "");
						paths.add(normalized || "/");
					}
				}
			} catch {}
			return paths;
		}

		function configWorkspaceDefault(cwd) {
			const map = cfg().workspaceDefaults;
			for (const key of [cwd, typeof cwd === "string" ? cwd.replace(/\/+$/, "") : undefined]) {
				if (!key) continue;
				const value = map[key];
				if (typeof value === "string" && value.trim()) {
					// 只对仍注册的工作区生效：工作区被删除后其映射即失效（prune 会把它从文件里清掉）。
					const normalized = key.replace(/\/+$/, "") || "/";
					if (!registeredPaths().has(normalized)) return undefined;
					return value.trim();
				}
			}
			return undefined;
		}

		/** 项目级覆盖：<cwd>/.dsh/agent-preset.json，支持 {"preset": id} / {"agentPreset": id} / "id"。 */
		async function projectFilePreset(cwd) {
			if (!cfg().projectFileOverrides || typeof cwd !== "string" || !cwd) return undefined;
			const file = path.join(cwd, ".dsh", "agent-preset.json");
			try {
				const text = await readFile(file, "utf8");
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					log.warn?.(`agent-change: 项目文件不是合法 JSON，已忽略：${file}`);
					return undefined;
				}
				const id =
					typeof parsed === "string" ? parsed :
					typeof parsed?.preset === "string" ? parsed.preset :
					typeof parsed?.agentPreset === "string" ? parsed.agentPreset :
					undefined;
				return id && id.trim() ? id.trim() : undefined;
			} catch (error) {
				if (error?.code !== "ENOENT") log.warn?.(`agent-change: 读取项目文件失败（已忽略）：${file}: ${String(error)}`);
				return undefined;
			}
		}
		//#endregion

		//#region 已删除工作区的映射清理
		let pruneBusy = false;
		let pruneTimer;

		/**
		 * 工作区被删除后其默认模式映射成了孤儿条目：不会影响启动（z.dict 对多余 key 完全
		 * 容忍），但会残留垃圾、且同路径的历史会话打开时仍会套用旧默认。这里对照注册表
		 * 把孤儿经 settings 服务写回删除（与设置页同一持久化通道，volatile-only 就地生效）。
		 */
		async function pruneWorkspaceDefaults(reason) {
			if (pruneBusy) return { status: "busy" };
			const map = cfg().workspaceDefaults;
			const keys = Object.keys(map);
			if (keys.length === 0) return { status: "empty" };
			const live = registeredPaths();
			const orphaned = keys.filter((key) => !live.has(key.replace(/\/+$/, "") || "/"));
			if (orphaned.length === 0) return { status: "none" };
			pruneBusy = true;
			try {
				// settings.update 对 dict 做深合并、删不掉已有 key；删除必须走 mutate 的 unset 路径。
				// 写回会触发 loader 的配置更新，与插件自身重载可能相互等待：加超时防止 pruneBusy 被挂起卡死。
				const ops = orphaned.map((key) => ({ op: "unset", path: ["workspaceDefaults", key] }));
				const write = sctx.settings.mutate(ENTRY_ID, ops, undefined);
				const timeout = new Promise((_, reject) => {
					setTimeout(() => reject(new Error("settings.mutate timed out (5s)")), 5000);
				});
				await Promise.race([write, timeout]);
				log.info?.(`agent-change: 已清理 ${orphaned.length} 个已删除工作区的默认模式映射（${orphaned.join("、")}）`);
				return { status: "written", removed: orphaned, reason };
			} catch (error) {
				log.warn?.(`agent-change: 清理已删除工作区的映射失败（${reason}）：${String(error)}`);
				return { status: "error", removed: orphaned, reason, error: String(error), name: error?.name };
			} finally {
				pruneBusy = false;
			}
		}

		function schedulePrune(reason, delay = 800) {
			clearTimeout(pruneTimer);
			pruneTimer = setTimeout(() => {
				pruneWorkspaceDefaults(reason).catch(() => {});
			}, delay);
		}
		//#endregion

		//#region 预设清单（形状自适应）
		async function listRoster() {
			try {
				const raw = await presets.list();
				const items = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : Array.isArray(raw?.items) ? raw.items : [];
				return items
					.map((item) => ({
						id: String(item?.id ?? ""),
						name: typeof item?.name === "string" ? item.name : undefined,
						description: typeof item?.description === "string" ? item.description : undefined,
						order: typeof item?.order === "number" ? item.order : 0,
						isDefault: item?.isDefault === true,
						broken: typeof item?.broken === "string" ? item.broken : undefined,
					}))
					.filter((item) => item.id);
			} catch (error) {
				log.warn?.(`agent-change: 读取预设清单失败：${error instanceof Error ? error.message : String(error)}`);
				return [];
			}
		}
		//#endregion

		//#region 占位回退（问题 1：预设被删 → 自动回退到默认模式）
		/** pid → { dispose, sessions }；dispose 由本插件持有。 */
		const placeholders = new Map();
		let refreshing = false;
		let rerunAfter = false;

		/**
		 * 读取一个会话的完整原始事件（rc.3 适配）。
		 * sessionQuery.filterEvents 自 rc.3 起只返回"能提取出文本"的语义文档，
		 * agent-preset/selected、turn/start 这类结构事件没有文本、永远不在结果里；
		 * 改用 readSession（同样按需加载整份日志，返回完整原始事件记录）。
		 */
		async function readSessionLog(sessionId) {
			const loaded = await sctx.sessionQuery.readSession(sessionId);
			return Array.isArray(loaded?.events) ? loaded.events : [];
		}

		/** 从原始事件流里取最后一条 agent-preset/selected 记录的预设 id。 */
		function lastSelectedPreset(events) {
			for (let index = events.length - 1; index >= 0; index--) {
				const event = events[index];
				if (event?.type !== "agent-preset/selected") continue;
				const data = event?.data;
				const candidate = typeof data?.agentPreset === "string" ? data.agentPreset : typeof data?.data?.agentPreset === "string" ? data.data.agentPreset : undefined;
				if (candidate) return candidate;
			}
			return undefined;
		}

		/**
		 * 扫描会话引用的预设 id。
		 * deep=false（自动路径）：只读 listSessions 的 header——廉价、不加载任何日志正文。
		 * deep=true（仅手动 + deepScan 开启）：对 header 没有记录预设的会话逐个 readSession 读原始日志。
		 * 已知取舍：会话"手动切到某预设、该预设后来被删"且 header 未更新的场景，只有 deep 扫描能发现。
		 */
		async function scanReferencedPresets(deep) {
			const referenced = new Map();
			let records = [];
			try {
				records = await sctx.sessionQuery.listSessions();
			} catch (error) {
				log.warn?.(`agent-change: 会话清单读取失败，跳过占位扫描：${String(error)}`);
				return referenced;
			}
			for (const record of records) {
				const header = record?.header;
				if (!header?.id) continue;
				let pid = typeof header.agentPreset === "string" && header.agentPreset ? header.agentPreset : undefined;
				if (!pid && deep) {
					try {
						pid = lastSelectedPreset(await readSessionLog(header.id));
					} catch {
						// 读不动的会话不阻塞整体扫描
					}
				}
				if (!pid) continue;
				const entry = referenced.get(pid) ?? { count: 0, samples: [] };
				entry.count += 1;
				if (entry.samples.length < 5) entry.samples.push(header.id);
				referenced.set(pid, entry);
			}
			return referenced;
		}

		async function disposeAllPlaceholders(reason) {
			for (const [pid, entry] of [...placeholders]) {
				placeholders.delete(pid);
				try {
					await entry.dispose?.();
				} catch (error) {
					log.warn?.(`agent-change: 释放占位预设 ${pid} 失败：${String(error)}`);
				}
			}
			if (placeholders.size === 0 && reason) log.info?.(`agent-change: 占位预设已全部释放（${reason}）`);
		}

		/** 自动扫描的最小间隔：插件安装/配置重载会在短时间内连发事件，全量扫描必须节流。 */
		const AUTOMATIC_SCAN_MIN_INTERVAL_MS = 10 * 60 * 1000;
		let lastAutomaticScanAt = 0;
		let lastScanSignature = "";
		let lastScanHadMissing = false;

		async function refreshPlaceholders(reason, { deep = false, automatic = false } = {}) {
			if (refreshing) {
				rerunAfter = true;
				return;
			}
			if (automatic && Date.now() - lastAutomaticScanAt < AUTOMATIC_SCAN_MIN_INTERVAL_MS) return;
			refreshing = true;
			try {
				if (!cfg().autoRepair) {
					await disposeAllPlaceholders("autoRepair 已关闭");
					return;
				}
				lastAutomaticScanAt = Date.now();
				// 关键门槛：等 Loader 树稳定后再读预设清单。启动窗口期用户 bundle 声明的
				// 预设（tutor/superpowers 等）可能还没注册，拿不完整清单对照会话 header
				// 会把活预设误判成"已删除"，之后打开这类会话会被错误翻回全局默认。
				try {
					await sctx.loader.await();
				} catch (error) {
					log.warn?.(`agent-change: 等待 Loader 稳定失败，跳过本轮占位扫描：${String(error)}`);
					return;
				}
				const roster = await listRoster();
				const live = new Set(roster.map((item) => item.id));
				// 预设 id 集合没变、上轮又没有占位时，短周期内无需重复扫描。
				const signature = live.size + ":" + [...live].sort().join(",");
				if (automatic && signature === lastScanSignature && placeholders.size === 0 && lastScanHadMissing === false) return;
				const referenced = await scanReferencedPresets(deep);
				let registered = 0;
				for (const [pid, info] of referenced) {
					if (live.has(pid) || placeholders.has(pid)) continue;
					try {
						const dispose = await presets.register({
							id: pid,
							name: `${pid} · 回退占位`,
							description: "原预设已被移除。这是 dsh-agent-change 为让引用它的历史会话仍能打开而注册的空占位；这类会话打开时自动切换回当前默认模式。",
							plugins: [],
							order: 9000,
						});
						placeholders.set(pid, { dispose, sessions: info });
						registered += 1;
						log.info?.(`agent-change: 预设 ${pid} 已不存在但被 ${info.count} 个会话引用，已注册回退占位`);
					} catch (error) {
						const text = String(error);
						if (!/Duplicate/i.test(text)) log.warn?.(`agent-change: 注册占位预设 ${pid} 失败：${text}`);
					}
				}
				for (const [pid, entry] of [...placeholders]) {
					if (!referenced.has(pid)) {
						placeholders.delete(pid);
						try {
							await entry.dispose?.();
						} catch (error) {
							log.warn?.(`agent-change: 释放占位预设 ${pid} 失败：${String(error)}`);
						}
					}
				}
				if (registered > 0 || !automatic) {
					log.info?.(`agent-change: 占位扫描完成（${reason}${deep ? "，深度" : ""}）：新增 ${registered}，现存 ${placeholders.size}`);
				}
				lastScanSignature = signature;
				lastScanHadMissing = referenced.size > 0 && [...referenced.keys()].some((pid) => !live.has(pid));
			} finally {
				refreshing = false;
				if (rerunAfter) {
					rerunAfter = false;
					schedulePlaceholderRefresh("rerun");
				}
			}
		}

		let refreshTimer;
		function schedulePlaceholderRefresh(reason, options) {
			clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				refreshPlaceholders(reason, options).catch((error) => log.warn?.(`agent-change: 占位扫描异常：${String(error)}`));
			}, 800);
		}
		//#endregion

		//#region 会话打开时的两条规则
		/** 占位会话 → 补写默认预设选择事件 + recompose；此后该会话永久落在默认模式。 */
		async function flipPlaceholderToDefault(agent, fromId) {
			// 防误伤：占位登记可能滞后于预设的重新注册（同名重建、启动窗口期）。
			// 只有确认预设此刻确实不存在时才回退；否则清理过期占位、保留会话当前模式。
			let stillMissing = false;
			try {
				await presets.resolve(fromId);
			} catch {
				// resolve 抛 agent-preset/not-found：确认缺失，继续回退。
				stillMissing = true;
			}
			if (!stillMissing) {
				const stale = placeholders.get(fromId);
				if (stale) {
					placeholders.delete(fromId);
					try {
						await stale.dispose?.();
					} catch (error) {
						log.warn?.(`agent-change: 释放过期占位预设 ${fromId} 失败：${String(error)}`);
					}
				}
				log.info?.(`agent-change: 预设 ${fromId} 实际仍存在，跳过回退并清理过期占位`);
				return;
			}
			const fallback = presets.defaultId;
			if (!fallback || fallback === fromId) return;
			try {
				await presets.recompose(agent.ctx, fallback);
			} catch (error) {
				log.warn?.(`agent-change: 会话 ${agent.id} 回退到 ${fallback} 失败：${String(error)}`);
				return;
			}
			try {
				agent.session.append("agent-preset/selected", { agentPreset: fallback });
			} catch (error) {
				log.warn?.(`agent-change: 会话 ${agent.id} 写入回退事件失败（本次运行已生效，重启后可能回到占位）：${String(error)}`);
				return;
			}
			log.info?.(`agent-change: 会话 ${agent.id} 的预设 ${fromId} 已移除，自动回退到 ${fallback}`);
		}

		sctx.on("agent/created", async (payload) => {
			try {
				const agent = payload?.agent;
				const header = agent?.session?.header;
				if (!agent || !header?.cwd) return;
				// 只处理根会话：subagent / fork 派生会话继承来源会话的预设，不掺和。
				if (header.parentSession !== undefined) return;
				const current = presets.composedPreset?.(agent.ctx);
				if (!current) return;
				// 规则 1：占位预设 → 打开即回退默认。
				if (placeholders.has(current)) {
					await flipPlaceholderToDefault(agent, current);
					return;
				}
				// 规则 2：工作区默认模式（只在"没有显式选择"= 仍是全局默认时生效）。
				const desired = (await projectFilePreset(header.cwd)) ?? configWorkspaceDefault(header.cwd);
				if (!desired || desired === current) return;
				if (current !== presets.defaultId) return;
				const live = new Set((await listRoster()).map((item) => item.id));
				if (!live.has(desired)) {
					log.warn?.(`agent-change: 工作区 ${header.cwd} 配置的默认预设 ${desired} 不存在，跟随全局默认`);
					return;
				}
				try {
					await presets.select(agent, desired);
					log.info?.(`agent-change: 会话 ${agent.id}（${header.cwd}）应用工作区默认预设 ${desired}`);
				} catch {
					// agent-preset/locked（会话已开始）等：静默让路，用户显式选择优先。
				}
			} catch (error) {
				log.warn?.(`agent-change: agent/created 处理失败：${error instanceof Error ? error.message : String(error)}`);
			}
		});
		//#endregion

		//#region 占位扫描触发点：激活 + 预设/插件清单变化（全部只做廉价 header 扫描）
		sctx.effect(() => {
			schedulePlaceholderRefresh("startup", { automatic: true });
			schedulePrune("startup");
			const offChanged = sctx.on?.("plugin-manager/changed", () => schedulePlaceholderRefresh("plugin-manager", { automatic: true }));
			const offReload = sctx.on?.("app-boot/config-reload", () => {
				// 先放手，给重新加载的预设声明让路，再重新扫描补位。
				disposeAllPlaceholders("config-reload").catch(() => {});
				schedulePlaceholderRefresh("config-reload", { automatic: true });
				schedulePrune("config-reload");
			});
			return () => {
				clearTimeout(refreshTimer);
				clearTimeout(pruneTimer);
				offChanged?.();
				offReload?.();
			};
		}, "agent-change: placeholder guardian");
		//#endregion

		//#region HTTP 桥
		/** 同源 + 回环守护（与 dsh-session-delete 相同的策略）。 */
		function isLoopbackRequest(request) {
			const address = request.socket.remoteAddress;
			if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
			const host = request.headers.host;
			if (typeof host !== "string") return false;
			let hostUrl;
			try {
				hostUrl = new URL("http://" + host);
			} catch {
				return false;
			}
			if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
			if (request.headers["sec-fetch-site"] === "cross-site") return false;
			const origin = request.headers.origin;
			if (origin === undefined) return true;
			try {
				return new URL(origin).host === hostUrl.host;
			} catch {
				return false;
			}
		}

		function writeJson(res, status, body) {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
			res.end(JSON.stringify(body));
		}

		async function readJsonBody(req) {
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > MAX_JSON_BODY_BYTES) return undefined;
				chunks.push(chunk);
			}
			try {
				return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return undefined;
			}
		}

		/** 路由兜底：任何异常都以 JSON 返回，绝不挂起连接。 */
		function guardRoute(handler) {
			return async (req, res) => {
				try {
					await handler(req, res);
				} catch (error) {
					if (!res.headersSent) {
						writeJson(res, 200, {
							ok: false,
							message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
							stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 4) : undefined,
						});
					}
				}
			};
		}

		/** 单个会话的预设与空白状态（live 走 live agent，冷会话走日志近似）。 */
		async function sessionState(sessionId) {
			let agent;
			try {
				agent = sctx.agents?.get?.(sessionId);
			} catch {
				agent = undefined;
			}
			if (agent) {
				const current = presets.composedPreset?.(agent.ctx);
				// 与宿主 agentPresets.select 的锁定判定逐字一致：
				// turnBoundary 存在未闭合 turn 或已发生任何 turn 即视为"已开始"；
				// 读不出投影时返回 unknown，让宿主自己裁决。
				let blank;
				try {
					const boundary = sctx.sessionProjections?.stateOf?.(agent.session, "turnBoundary");
					blank = !(boundary && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0));
				} catch {
					blank = undefined;
				}
				return { sessionId, current, blank, cwd: agent.session?.header?.cwd, live: true };
			}
			// 冷会话：header + 原始日志拿当前预设与 cwd，turn/start 事件定空白。
			// 读不动时 blank 返回 unknown：客户端会照常尝试切换，由宿主 select() 的
			// 锁定检查给出权威结果（而不是在这里武断地拒绝）。
			try {
				const records = await sctx.sessionQuery.listSessions();
				const header = records.find((record) => record?.header?.id === sessionId)?.header;
				const current = typeof header?.agentPreset === "string" ? header.agentPreset : undefined;
				let blank;
				try {
					const events = await readSessionLog(sessionId);
					// rc.3 适配：filterEvents 查不到无文本的 turn/start，改读原始事件流。
					blank = !events.some((event) => event?.type === "turn/start");
				} catch {
					blank = undefined;
				}
				return { sessionId, current, blank, cwd: header?.cwd, live: false };
			} catch (error) {
				return { sessionId, current: undefined, blank: undefined, cwd: undefined, live: false, error: String(error) };
			}
		}

		const routes = [
			{
				kind: "exact",
				path: `${API_PREFIX}/state`,
				handler: async (req, res) => {
					if (!isLoopbackRequest(req)) return;
					const url = new URL(req.url ?? "/", "http://localhost");
					const sessionId = url.searchParams.get("sessionId") ?? undefined;
					const roster = await listRoster();
					pruneWorkspaceDefaults("state").catch(() => {});
					const placeholdersInfo = [];
					for (const [pid, entry] of placeholders) placeholdersInfo.push({ id: pid, sessions: entry.sessions?.count ?? 0 });
					let session;
					if (sessionId) session = await sessionState(sessionId);
					const cwd = session?.cwd;
					const projectDefault = cwd ? (await projectFilePreset(cwd)) ?? null : null;
					const mappedDefault = cwd ? configWorkspaceDefault(cwd) ?? null : null;
					writeJson(res, 200, {
						ok: true,
						presets: roster,
						defaultId: presets.defaultId,
						entryId: ENTRY_ID,
						config: {
							workspaceDefaults: cfg().workspaceDefaults,
							projectFileOverrides: cfg().projectFileOverrides,
							autoRepair: cfg().autoRepair,
							deepScan: cfg().deepScan,
						},
						placeholders: placeholdersInfo,
						session,
						workspace: cwd ? { path: cwd } : null,
						projectFileDefault: projectDefault,
						mappedDefault,
					});
				},
			},
			{
				kind: "exact",
				path: `${API_PREFIX}/workspaces`,
				handler: async (req, res) => {
					if (!isLoopbackRequest(req)) return;
					pruneWorkspaceDefaults("workspaces").catch(() => {});
					try {
						const workspaces = sctx.workspaceRegistry.list().map((workspace) => ({
							id: String(workspace.id),
							path: workspace.path,
							title: workspace.title,
						}));
						writeJson(res, 200, { ok: true, workspaces });
					} catch (error) {
						writeJson(res, 200, { ok: false, message: String(error), workspaces: [] });
					}
				},
			},
			{
				kind: "exact",
				path: `${API_PREFIX}/prune`,
				handler: async (req, res) => {
					if (!isLoopbackRequest(req)) return;
					const result = await pruneWorkspaceDefaults("manual");
					writeJson(res, 200, { ok: true, result, map: cfg().workspaceDefaults });
				},
			},
			{
				kind: "exact",
				path: `${API_PREFIX}/repair`,
				handler: async (req, res) => {
					if (!isLoopbackRequest(req)) return;
					const body = await readJsonBody(req);
					if (body !== undefined && body !== null && typeof body !== "object") {
						writeJson(res, 400, { ok: false, message: "malformed JSON body" });
						return;
					}
					try {
						// 深度事件扫描（逐会话读日志）代价高：仅在 deepScan 开启时随手动触发执行。
						await refreshPlaceholders("manual", { deep: cfg().deepScan });
						const placeholdersInfo = [];
						for (const [pid, entry] of placeholders) placeholdersInfo.push({ id: pid, sessions: entry.sessions?.count ?? 0 });
						writeJson(res, 200, { ok: true, placeholders: placeholdersInfo, autoRepair: cfg().autoRepair, deepScan: cfg().deepScan });
					} catch (error) {
						writeJson(res, 200, { ok: false, message: String(error) });
					}
				},
			},
		];

		sctx.effect(() => {
			const disposers = routes.map((route) => sctx.webServer.register({ ...route, handler: guardRoute(route.handler) }));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "agent-change: api bridge");
		//#endregion

		sctx.effect(() => {
			log.info?.(`dsh-agent-change: 就绪（桥 ${API_PREFIX}，工作区默认 ${Object.keys(cfg().workspaceDefaults).length} 项，占位 ${placeholders.size} 个）`);
		}, "agent-change: ready log");
	});
}
