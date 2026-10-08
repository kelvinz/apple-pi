/**
 * apple-pi.ts — a home for Pi UI and workflow tweaks.
 *
 * Current features:
 *
 * 1. A footer showing the current provider's plan usage
 *    (windows with percent left, a countdown, and the local reset time).
 *    Codex and Z.ai only: Anthropic does not allow subscription use outside
 *    its own apps, and zai-coding-cn is the China-only plan.
 * 2. A friendlier replacement for the built-in footer: same data (directory,
 *    branch, session name, tokens, cost, context, model, thinking level,
 *    extension statuses) in plain language, plus the model's average output
 *    speed over the last 10 replies.
 * 3. A small "→ using <tool> — <path>" title above each tool block when a path
 *    is available. The built-in call and result rendering stay in place, so
 *    expand/collapse is untouched.
 * 4. A small italic title above assistant text ("✦ reply") and thinking
 *    ("… thinking") blocks. Display-only; user messages stay untouched.
 * 5. A right-aligned previous-user-message button above the fullscreen editor.
 * 6. Fullscreen copy joins lines that the transcript wrapped at its width, so
 *    a copied paragraph pastes as one line. Intentional breaks stay. Inside
 *    Herdr, selections go through the terminal to the viewing computer's clipboard.
 * 7. Usage-limit errors automatically resume after reset + one minute.
 *    Messages submitted while waiting join the thread without starting a turn.
 *    Timers belong only to the running session and are cleared on shutdown.
 *
 * Plan data refreshes when you send a message, after each turn, when the
 * agent settles, when you change model, and on /usage, but not more than
 * once a minute per provider. Only the
 * provider behind the current model is fetched, because it is the only one the
 * footer shows. The footer re-renders from a live snapshot on every frame.
 *
 * Data sources (same ones oh-my-pi uses):
 *   Z.ai    GET https://api.z.ai/api/monitor/usage/quota/limit
 *   Codex   GET https://chatgpt.com/backend-api/wham/usage  (OAuth from /login)
 */
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, ReadonlyFooterDataProvider, Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	SettingsManager,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

const MIN_FETCH_GAP_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8 * 1000;
const TOKEN_EXPIRED_NOTE = "token expired — run /login";
const BAR_WIDTH = 10;
// Built once: the footer re-renders on every frame, and building a formatter
// per row per frame is the most expensive thing on that path.
const RESET_DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const RESET_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY_SECONDS = 24 * 3600;

type Row = { label: string; pct?: number; resetAt?: number; windowSeconds?: number; bucket?: string };

// The window length decides whether to show the date, not the time left.
// Both formatters use the computer's local time zone. Unknown windows get a date.
export function formatReset(row: Row, now = Date.now()): string {
	const { resetAt, windowSeconds } = row;
	if (resetAt === undefined || !Number.isFinite(new Date(resetAt).getTime())) return "";
	const time = RESET_TIME.format(resetAt);
	const shortWindow = windowSeconds !== undefined && windowSeconds > 0 && windowSeconds < DAY_SECONDS;
	const stamp = shortWindow ? time : `${RESET_DATE.format(resetAt)}, ${time}`;
	// Recompute on each render; do not freeze the countdown in the usage cache.
	const secs = Math.floor((resetAt - now) / 1000);
	if (secs <= 0) return `resets now (${stamp})`;
	const d = Math.floor(secs / DAY_SECONDS);
	const h = Math.floor((secs % DAY_SECONDS) / 3600);
	const m = Math.floor((secs % 3600) / 60);
	const s = secs % 60;
	// Keep the existing two-unit countdown, including seconds in the final hour.
	const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
	return `resets ${text} (${stamp})`;
}

// `stale` marks rows kept from an earlier fetch after a refresh failed.
type ProviderStatus = { plan?: string; rows: Row[]; note?: string; stale?: string };
type WarningCategory = "snapshot" | "footer" | "tool-render" | "registration";
type BuiltinToolDefinition = ToolDefinition<any, any, any>;
type BuiltinToolFactory = (cwd: string, options?: any) => BuiltinToolDefinition;
type ToolCallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ToolCallArgs = Parameters<ToolCallRenderer>[0];
type ToolCallContext = Parameters<ToolCallRenderer>[2];
type PartialToolArgs = { path?: unknown; file_path?: unknown };
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

const WARNING_MESSAGES: Record<WarningCategory, string> = {
	snapshot: "apple-pi snapshot unavailable",
	footer: "apple-pi footer unavailable",
	"tool-render": "apple-pi tool renderer unavailable",
	registration: "apple-pi registration unavailable",
};

// pi provider id -> usage cache key
const PROVIDER_KEYS: Record<string, string> = {
	zai: "zai",
	"openai-codex": "codex",
};

// Pi exposes no public transcript-layout getter. Keep this read-only adapter
// local: use the last rendered frame for its exact document width and offset.
// Do not replace the layout, input handlers, or built-in jump-to-latest control.
type TranscriptLayoutBox = {
	component: Component;
	rect: { width: number };
	children: TranscriptLayoutBox[];
	scrollView?: { scrollTop: number; scrollTo(row: number): void };
};

function findScrollBox(box: TranscriptLayoutBox, scrollView: unknown): TranscriptLayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = findScrollBox(child, scrollView);
		if (found) return found;
	}
}

// A rendered row: quote bars, indent, an optional list marker, then the text.
const ROW_PREFIX = /^((?:│ )*)( *)((?:[-*+•]|\d+[.)]) (?:\[[ x]\] )?)?/;

type ReflowRow = { cols: number; body: string; hang?: string; list: boolean; table: boolean };

/**
 * Join rows that the transcript wrapped at `room` columns. A row joins the one
 * above only when the wrap was forced: its first word could not fit on the row
 * above. Short lines, code, tables, and new list items keep their breaks. A row
 * with an indent joins only a list item, so indented code never merges.
 * `pad` is the transcript padding on each whole row. `startCol` is where the
 * selection starts on the first row, which can be part of a row.
 */
export function reflowText(text: string, room: number, pad = 0, startCol = 0): string {
	const out: string[] = [];
	let prev: ReflowRow | undefined;
	text.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
		const partial = i === 0 && startCol > pad;
		const line = !partial && raw.startsWith(" ".repeat(pad)) ? raw.slice(pad) : raw;
		const [lead, quote, indent, marker = ""] = ROW_PREFIX.exec(line)!;
		const body = line.slice(lead.length);
		const table = /[│─]/.test(body);
		if (prev && prev.body && !prev.table && body && !table && !marker && (!indent || prev.list)) {
			// The first row of a partial selection has no known prefix.
			const sameBlock = prev.hang === undefined ? !indent : lead === prev.hang;
			// Wrapping cuts a word longer than the row into chunks with no space.
			const brokenWord = prev.cols === room && !prev.body.includes(" ");
			const forced = brokenWord || prev.cols + 1 + visibleWidth(body.split(" ")[0]) > room;
			if (sameBlock && forced) {
				out[out.length - 1] += (brokenWord ? "" : " ") + body;
				prev = { ...prev, cols: visibleWidth(line), body, hang: lead };
				return;
			}
		}
		out.push(line);
		prev = {
			cols: partial ? startCol - pad + visibleWidth(raw) : visibleWidth(line),
			body,
			hang: partial ? undefined : quote + indent + " ".repeat(marker.length),
			list: marker !== "",
			table,
		};
	});
	return out.join("\n");
}

const ORIGINAL_COPY = Symbol.for("apple-pi.copySelection");
// Same encoded-payload ceiling as Pi's built-in terminal clipboard writer.
const MAX_CLIPBOARD_BASE64_LENGTH = 100_000;
type CopySelection = (text: string) => Promise<boolean | string>;
// Pi exposes no public copy hook. These fields exist on the fullscreen TUI only.
type CopyTui = {
	copySelection?: CopySelection;
	[ORIGINAL_COPY]?: CopySelection;
	getSelectionBounds?: () => { start: { col: number; scrollView?: unknown } } | undefined;
	currentLayout?: { root: TranscriptLayoutBox };
};

/**
 * Reflow text before the fullscreen TUI copies a selection. The pristine copy
 * function is kept under a global symbol, so a /reload replaces the wrapper
 * instead of stacking a new one on it. Copy never fails because of reflow:
 * any problem copies the text as selected. Herdr panes can lack SSH variables,
 * so Pi may otherwise report success from writing only the remote clipboard.
 * Route selections through Herdr's terminal forwarding instead, for both local
 * and remote panes. Leave Pi's native route unchanged outside Herdr.
 */
export function patchCopyReflow(tui: TUI, outputPad: () => number): void {
	const t = tui as unknown as CopyTui;
	const original = t[ORIGINAL_COPY] ?? t.copySelection;
	if (typeof original !== "function") return;
	t[ORIGINAL_COPY] = original;
	t.copySelection = async text => {
		let copied = text;
		try {
			// Only selections in a scroll view (the transcript) have a known wrap width.
			const start = t.getSelectionBounds?.()?.start;
			const root = t.currentLayout?.root;
			const width = start?.scrollView && root ? findScrollBox(root, start.scrollView)?.children[0]?.rect.width : undefined;
			const pad = outputPad();
			if (start && width) copied = reflowText(text, width - 2 * pad, pad, start.col);
		} catch {
			// Copy the selection unchanged.
		}
		if (process.env.HERDR_ENV === "1") {
			// OSC 52 is a clipboard-write request, not a shell command. Encoding
			// the whole UTF-8 selection also keeps terminal controls inert.
			const encoded = Buffer.from(copied, "utf8").toString("base64");
			if (encoded.length > MAX_CLIPBOARD_BASE64_LENGTH) {
				return "Selection is too large to copy through the terminal. Copy a smaller selection.";
			}
			try {
				tui.terminal.write(`\x1b]52;c;${encoded}\x07`);
				// The terminal sends no acknowledgement. Pi's normal "Copied"
				// feedback means the request was sent, not independently verified.
				return true;
			} catch {
				// Do not fall back to a remote-only native write and claim success.
				return "Could not send the selection to your terminal clipboard.";
			}
		}
		return original(copied);
	};
}

export function createPreviousMessageWidget(tui: TUI, theme: Theme, onUnavailable: () => void): Component {
	let buttonStart = 0;
	let buttonEnd = 0;

	function jump(): void {
		const frame = (tui as unknown as {
			currentLayout?: { root: TranscriptLayoutBox; primaryScrollView?: TranscriptLayoutBox["scrollView"] };
		}).currentLayout;
		if (!frame?.root || !frame.primaryScrollView) {
			onUnavailable();
			return;
		}
		const document = findScrollBox(frame.root, frame.primaryScrollView)?.children[0];
		if (!document || document.component.constructor !== Container) {
			onUnavailable();
			return;
		}
		const scroll = frame.primaryScrollView;
		let target: number | undefined;
		const visit = (component: Component, row: number): number => {
			// Only plain containers concatenate children without padding. Stop at
			// message/tool components so nested content cannot become a target.
			if (component.constructor === Container) {
				let next = row;
				for (const child of (component as Container).children) next += visit(child, next);
				return next - row;
			}
			const height = component.render(document.rect.width).length;
			if (component instanceof UserMessageComponent && height > 0 && row < scroll.scrollTop && row + height <= scroll.scrollTop) {
				target = row;
			}
			return height;
		};
		visit(document.component, 0);
		if (target !== undefined) {
			scroll.scrollTo(target);
			tui.requestRender();
		}
	}

	return {
		invalidate() {},
		render(width: number): string[] {
			buttonStart = buttonEnd = 0;
			if (tui.mode !== "fullscreen" || width < 1) return [];
			const label = truncateToWidth(" ↑ previous message ", width, "");
			buttonEnd = width;
			buttonStart = width - visibleWidth(label);
			return [" ".repeat(buttonStart) + theme.fg("accent", label)];
		},
		handleMouse(event: TuiMouseEvent) {
			if (tui.mode !== "fullscreen" || event.y !== 0 || event.x < buttonStart || event.x >= buttonEnd || event.button !== "left") return;
			// Consume press as well as click, without moving focus from the editor.
			if (event.type === "press") return { handled: true };
			if (event.type !== "click") return;
			try { jump(); } catch { onUnavailable(); }
			return { handled: true };
		},
	};
}

const RESUME_BUFFER_MS = 60_000;
const UNKNOWN_RESET_RETRY_MS = 15 * 60_000;
const AUTO_RESUME_STATUS = "apple-pi-auto-resume";

// Only assistant errors qualify. Ordinary 429s, auth errors, and successful
// replies discussing quotas must never start unattended work.
export function isUsageLimit(error: string): boolean {
	return /usage[_ ]limit(?:[_ ]reached)?|(?:quota|subscription limit).{0,50}(?:exhausted|exceeded|reached)|(?:exhausted|exceeded|reached).{0,50}(?:quota|subscription limit)/i.test(error);
}

// Pi's Codex adapter turns resets_at into "Try again in ~N min.". Keep the
// failure's timestamp, rather than measuring N minutes from a later HTTP fetch.
export function usageRetryAt(error: string, failedAt: number): number | undefined {
	const retry = /try again in\s*[~≈]?\s*((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*)+)/i.exec(error)?.[1];
	if (!retry) return undefined;
	let duration = 0;
	for (const match of retry.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
		const unit = match[2].toLowerCase()[0];
		duration += Number(match[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit] ?? 0);
	}
	const stamp = failedAt + duration;
	return Number.isFinite(stamp) && Number.isFinite(new Date(stamp).getTime()) ? stamp : undefined;
}

/** Session-owned only: no cron, subprocess, persisted job, or startup replay. */
export function installAutoResume(
	pi: ExtensionAPI,
	freshUsage: (ctx: ExtensionContext) => Promise<ProviderStatus | undefined>,
): void {
	type Wait = {
		ctx: ExtensionContext;
		sessionId: string;
		provider: string | undefined;
		model: string | undefined;
		error: string;
		failedAt: number;
		deadline?: number;
		queued: number;
	};
	let active = false;
	let waiting: Wait | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dialogs = 0;
	let unknownRetries = 0;

	function status(ctx: ExtensionContext, text?: string): void {
		try { ctx.ui.setStatus(AUTO_RESUME_STATUS, text); } catch { /* Stale UI. */ }
	}

	function clear(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const old = waiting;
		waiting = undefined;
		if (old) status(old.ctx);
	}

	function current(wait: Wait): boolean {
		return active && waiting === wait &&
			wait.ctx.sessionManager.getSessionId() === wait.sessionId &&
			wait.ctx.model?.provider === wait.provider && wait.ctx.model?.id === wait.model;
	}

	function show(wait: Wait): void {
		const when = wait.deadline === undefined ? "checking reset time" : `at ${RESET_DATE.format(wait.deadline)}, ${RESET_TIME.format(wait.deadline)}`;
		status(wait.ctx, `Auto-resume ${when}${wait.queued ? ` · ${wait.queued} queued` : ""}`);
	}

	function tick(wait: Wait): void {
		if (waiting !== wait) return;
		timer = undefined;
		if (!current(wait)) { clear(); return; }
		const remaining = wait.deadline! - Date.now();
		if (remaining > 0 || !wait.ctx.isIdle() || dialogs > 0) {
			// Absolute deadlines survive sleep/wake; short timer chunks also avoid
			// Node's ~24-day timeout overflow on long subscription windows.
			timer = setTimeout(() => tick(wait), remaining > 0 ? Math.min(remaining, 60_000) : 1000);
			timer.unref?.();
			return;
		}
		clear(); // Clear before sending: never let our continuation queue itself.
		try { pi.sendUserMessage("continue"); } catch {
			try { wait.ctx.ui.notify("Auto-resume could not submit a continuation.", "warning"); } catch { /* Stale UI. */ }
		}
	}

	pi.on("session_start", (_event, ctx) => {
		clear();
		active = ctx.mode === "tui" || ctx.mode === "rpc";
		dialogs = 0;
		unknownRetries = 0;
	});
	pi.on("session_shutdown", () => {
		active = false;
		clear();
		dialogs = 0;
	});
	// A different branch or model must not inherit an old failure's timer.
	pi.on("session_tree", () => { clear(); unknownRetries = 0; });
	pi.on("model_select", () => { clear(); unknownRetries = 0; });
	pi.on("ui_prompt_start", () => { dialogs++; });
	pi.on("ui_prompt_end", () => { dialogs = Math.max(0, dialogs - 1); });
	pi.on("cache_warming_decision", () => waiting ? { action: "stop" } : undefined);

	pi.on("message_end", (event, ctx) => {
		if (!active || event.message.role !== "assistant") return;
		const message = event.message;
		if (message.stopReason !== "error" || !isUsageLimit(message.errorMessage ?? "")) {
			clear();
			unknownRetries = 0;
			return;
		}
		const queued = waiting?.queued ?? 0;
		clear();
		waiting = {
			ctx, sessionId: ctx.sessionManager.getSessionId(),
			provider: ctx.model?.provider, model: ctx.model?.id,
			error: message.errorMessage!, failedAt: Date.now(), queued,
		};
		show(waiting);
	});

	pi.on("input", (event, ctx) => {
		const wait = waiting;
		// Built-in /commands remain usable. Extension-generated messages are
		// also real prompts and should queue rather than hammer an exhausted plan.
		if (!wait || !current(wait) || event.text.startsWith("/")) return;
		wait.ctx = ctx;
		const content = event.images?.length
			? [{ type: "text" as const, text: event.text }, ...event.images]
			: event.text;
		// Custom messages with triggerTurn:false appear immediately in the
		// transcript and are converted to user messages in Pi's provider context.
		// Unlike sendUserMessage, this does not start a premature model request.
		pi.sendMessage({ customType: "apple-pi-queued", content, display: true }, { triggerTurn: false });
		wait.queued++;
		show(wait);
		return { action: "handled" };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const wait = waiting;
		if (!wait || !current(wait) || wait.deadline !== undefined) return;
		wait.ctx = ctx;
		let usage: ProviderStatus | undefined;
		try { usage = await freshUsage(ctx); } catch { /* Error hint still works. */ }
		// Shutdown/reload/session replacement can happen during the fetch.
		if (!current(wait) || wait.deadline !== undefined) return;
		const hint = usageRetryAt(wait.error, wait.failedAt);
		// Additional buckets may belong to another model, so do not let them
		// postpone a main-plan retry. Never schedule from retained stale rows.
		const resets = usage && !usage.stale ? usage.rows
			.filter(row => !row.bucket && row.pct !== undefined && row.pct >= 100 && row.resetAt !== undefined && Number.isFinite(new Date(row.resetAt).getTime()))
			.map(row => row.resetAt!) : [];
		const known = [hint, ...resets].filter((stamp): stamp is number => stamp !== undefined);
		if (known.length) {
			wait.deadline = Math.max(Date.now(), ...known) + RESUME_BUFFER_MS;
			unknownRetries = 0;
		} else {
			// No trustworthy reset information: retry conservatively, backing off
			// to one hour rather than inventing an exact reset or looping rapidly.
			wait.deadline = Date.now() + Math.min(UNKNOWN_RESET_RETRY_MS * 2 ** Math.min(unknownRetries++, 2), 60 * 60_000);
		}
		show(wait);
		timer = setTimeout(() => tick(wait), Math.min(wait.deadline - Date.now(), 60_000));
		timer.unref?.();
	});
}

export default function (pi: ExtensionAPI) {
	// Per provider, so switching model shows the new plan right away instead of
	// waiting out a gap another provider started.
	const cache = new Map<string, ProviderStatus>();
	const lastFetch = new Map<string, number>();
	const inFlight = new Map<string, Promise<boolean>>();
	// Set when the footer is installed. New plan data arrives after the frame
	// that asked for it, so the screen needs a nudge to show it.
	let requestRender: () => void = () => {};
	let warningContext: ExtensionContext | undefined;
	let sessionActive = false;
	const reportedWarnings = new Set<WarningCategory>();

	// Renderers can fail while pi is drawing. Defer each fixed warning so
	// reporting never runs inside render() or recursively reports notify errors.
	function reportWarning(category: WarningCategory): void {
		const context = warningContext;
		if (!sessionActive || !context?.hasUI || typeof context.ui?.notify !== "function") return;
		if (reportedWarnings.has(category)) return;
		reportedWarnings.add(category);
		const notifyContext = context;
		setImmediate(() => {
			if (
				!sessionActive ||
				warningContext !== notifyContext ||
				!notifyContext.hasUI ||
				typeof notifyContext.ui?.notify !== "function"
			) return;
			try {
				notifyContext.ui.notify(WARNING_MESSAGES[category], "warning");
			} catch {
				// Notification failure must not escape or report itself.
			}
		});
	}

	// ---------- auth ----------

	function readAuth(): Record<string, any> {
		try {
			return JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
		} catch {
			return {};
		}
	}

	// Pi's default transcript padding is 1; the global setting can make it 0.
	function outputPad(): number {
		try {
			return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"))?.outputPad === 0 ? 0 : 1;
		} catch {
			return 1;
		}
	}

	function envKey(name: string): string | undefined {
		const v = process.env[name];
		return v && v.trim() ? v.trim() : undefined;
	}

	// ---------- text helpers ----------

	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

	// Anything can be thrown, including values with no `message` and no useful
	// `toString`, so the text is taken defensively.
	const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e));

	// Footer values are plain external text until they are styled. Keep line
	// separators as spaces, and make other terminal controls visible.
	function plainFooterText(text: string): string {
		return text
			.replace(/[\r\n\t\u2028\u2029]/g, " ")
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	}

	// Reset stamps arrive in seconds from some windows and milliseconds from
	// others. A millisecond stamp is past the year 2001; a second stamp is not.
	const toMs = (v: number | undefined): number | undefined => (v === undefined ? undefined : v > 1e12 ? v : v * 1000);

	// Both sources report percent *used* on a 0-100 scale, verified against live
	// responses (Codex `used_percent`, Z.ai `percentage`). Values are taken at
	// face value: an earlier version scaled anything below 1 up by 100x, which
	// rendered 0.4% used as 40% used.
	const clampPercent = (v: number): number => Math.min(Math.max(v, 0), 100);

	// Rows carry percent *used* — the native shape of both APIs. The footer
	// reports what is left, so the bar and the number both invert here, and only
	// here. The source's own precision is preserved rather than rounded to whole
	// points; two decimals is enough to absorb float noise (100 - 99.6 lands on
	// 0.400000000000005) without inventing precision the provider never sent.
	//
	// That precision is capped by the provider, not by this code: Codex sends
	// whole numbers, and Z.ai rounds *up* to a minimum of 1, so 42 tokens into a
	// 5-hour window still reports 1% used. Z.ai's "99% left" understates headroom.
	const percentLeft = (used: number): number => Math.round((100 - clampPercent(used)) * 100) / 100;

	// Filled blocks are headroom, so the bar drains as the window is consumed.
	// Narrow terminals pass a smaller width rather than let the bar shove the
	// percentage off the end of the line.
	function bar(used: number | undefined, barWidth: number = BAR_WIDTH): string {
		if (used === undefined) return "░".repeat(barWidth);
		const filled = Math.round((percentLeft(used) / 100) * barWidth);
		return "▓".repeat(filled) + "░".repeat(barWidth - filled);
	}

	function pctText(used: number | undefined): string {
		return used === undefined ? "?% left" : `${percentLeft(used)}% left`;
	}

	function shortTokens(n: number): string {
		const trim = (s: string) => s.replace(/\.0$/, "");
		if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
		if (n >= 1_000) return `${trim((n / 1_000).toFixed(1))}k`;
		return String(n);
	}

	function homeTilde(p: string): string {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		if (!home) return p;
		let root = home;
		while (root.length > sep.length && root.endsWith(sep)) root = root.slice(0, -sep.length);
		if (p === root) return "~";
		if (root === sep) return p.startsWith(sep) ? `~${p}` : p;
		return p.startsWith(root + sep) ? `~${p.slice(root.length)}` : p;
	}

	// ---------- fetchers ----------

	// One request shape for both providers: same timeout, same JSON accept, and
	// the same two failure notes. A response with no `json` carries a `note`.
	async function getJson(url: string, headers: Record<string, string>): Promise<{ json?: any; note?: string }> {
		const res = await fetch(url, {
			headers: { accept: "application/json", ...headers },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return { note: res.status === 401 ? TOKEN_EXPIRED_NOTE : `error ${res.status}` };
		return { json: await res.json() };
	}

	async function fetchZai(key: string): Promise<ProviderStatus> {
		const { json, note } = await getJson("https://api.z.ai/api/monitor/usage/quota/limit", {
			authorization: `Bearer ${key}`,
		});
		if (!json) return { rows: [], note };
		const data = json?.data ?? {};
		const limits: any[] = Array.isArray(data.limits) ? data.limits : [];
		const rows: Row[] = [];
		const seen = new Map<string, number>();
		for (const l of limits) {
			// Side-tool quota (search/zread), not the plan limit. The TOKENS_LIMIT row
			// that survives carries its own `nextResetTime`, but only once the window
			// is live: Z.ai's 5-hour window rolls from first use, so an idle window
			// omits the field entirely and that row renders without a countdown.
			if (l?.type === "TIME_LIMIT") continue;
			const size = num(l?.number);
			const count = size !== undefined && size > 0 ? size : 1;
			let label: string;
			switch (l?.unit) {
				case 3: label = `${count}h`; break;
				case 4: label = `${count}d`; break;
				case 5: label = count > 1 ? `${count}mo` : "monthly"; break;
				case 6: label = "weekly"; break;
				default: label = "quota";
			}
			// Same window can appear once per meter (requests / tokens / credits).
			const n = (seen.get(label) ?? 0) + 1;
			seen.set(label, n);
			if (n > 1 && typeof l?.type === "string") label += ` ${l.type}`;
			// `percentage` arrives rounded; `currentValue` out of `usage` (the
			// allowance, with `remaining` as its complement) is exact when sent.
			const allowance = num(l?.usage);
			const consumed = num(l?.currentValue);
			const exact =
				allowance !== undefined && allowance > 0 && consumed !== undefined ? (consumed / allowance) * 100 : undefined;
			const windowSeconds =
				l?.unit === 3 ? count * 3600 :
				l?.unit === 4 ? count * DAY_SECONDS :
				l?.unit === 6 ? count * 7 * DAY_SECONDS : undefined;
			rows.push({ label, pct: exact ?? num(l?.percentage), resetAt: toMs(num(l?.nextResetTime)), windowSeconds });
		}
		return { plan: typeof data.level === "string" ? data.level : undefined, rows };
	}

	function codexAccountId(token: string): string | undefined {
		try {
			const claims = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/");
			if (!claims) return undefined;
			const payload = JSON.parse(Buffer.from(claims, "base64").toString("utf8"));
			return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		} catch {
			return undefined;
		}
	}

	async function fetchCodex(access: string, accountId?: string): Promise<ProviderStatus> {
		const acc = accountId ?? codexAccountId(access);
		const { json, note } = await getJson("https://chatgpt.com/backend-api/wham/usage", {
			authorization: `Bearer ${access}`,
			"user-agent": "pi-usage-limits",
			...(acc ? { "chatgpt-account-id": acc } : {}),
		});
		if (!json) return { rows: [], note };
		const row = (w: any): Row => {
			const secs = num(w?.limit_window_seconds);
			const label = !secs
				? "window"
				: secs >= 7 * 24 * 3600
					? "weekly"
					: secs >= 24 * 3600
						? `${Math.round(secs / (24 * 3600))}-day`
						: `${Math.round(secs / 3600)}-hour`;
			// A stamp when the provider sends one, otherwise a duration from now.
			const resetAfter = num(w?.reset_after_seconds);
			return {
				label,
				pct: num(w?.used_percent),
				windowSeconds: secs,
				resetAt: toMs(num(w?.reset_at)) ?? (resetAfter === undefined ? undefined : Date.now() + resetAfter * 1000),
			};
		};
		const rows: Row[] = [];
		if (json.rate_limit?.primary_window) rows.push(row(json.rate_limit.primary_window));
		if (json.rate_limit?.secondary_window) rows.push(row(json.rate_limit.secondary_window));
		// Separately metered buckets (e.g. "gpt-reserve") consume plan quota too.
		for (const extra of Array.isArray(json.additional_rate_limits) ? json.additional_rate_limits : []) {
			const name = typeof extra?.limit_name === "string" ? extra.limit_name : "extra";
			for (const w of [extra?.rate_limit?.primary_window, extra?.rate_limit?.secondary_window]) {
				if (!w) continue;
				const r = row(w);
				rows.push({ ...r, label: `${name} ${r.label}`, bucket: name });
			}
		}
		return { plan: typeof json.plan_type === "string" ? json.plan_type : undefined, rows };
	}

	// ---------- providers ----------

	// Each entry reads its own credentials and returns a job, or undefined when
	// that provider is not logged in. One table keeps the cache keys, the
	// credential shapes, and the fetchers together.
	const PROVIDERS: Record<string, (auth: Record<string, any>) => Promise<ProviderStatus> | undefined> = {
		zai: auth => {
			const key = auth?.zai?.type === "api_key" ? auth.zai.key : envKey("ZAI_API_KEY");
			return key ? fetchZai(key) : undefined;
		},
		codex: auth => {
			const cred = auth?.["openai-codex"];
			return cred?.type === "oauth" && cred.access
				? fetchCodex(cred.access, typeof cred.accountId === "string" ? cred.accountId : undefined)
				: undefined;
		},
	};

	// The usage cache key for the model in use, or undefined when that provider
	// has no usage endpoint wired up.
	function activeKey(): string | undefined {
		return stats.provider ? PROVIDER_KEYS[stats.provider] : undefined;
	}

	// Returns true when provider data was actually re-read. Every failure ends as
	// a note in the footer, so this never rejects: pi must not crash over a
	// status line. The running fetch is kept so a caller can wait for it.
	function fetchProvider(key: string, force: boolean): Promise<boolean> {
		if (inFlight.has(key)) return Promise.resolve(false);
		if (!force && Date.now() - (lastFetch.get(key) ?? 0) < MIN_FETCH_GAP_MS) return Promise.resolve(false);
		const job = readProvider(key).finally(() => inFlight.delete(key));
		inFlight.set(key, job);
		return job;
	}

	async function readProvider(key: string): Promise<boolean> {
		let next: ProviderStatus;
		let failed = false;
		try {
			const job = PROVIDERS[key]?.(readAuth());
			next = job ? await job : { rows: [], note: "not set up" };
			failed = job !== undefined && next.rows.length === 0 && next.note !== undefined;
		} catch (e) {
			next = { rows: [], note: errText(e) };
			failed = true;
		}
		// A blip must not erase the last good numbers: keep them, say they are old.
		const prev = cache.get(key);
		cache.set(key, failed && prev?.rows.length ? { ...prev, stale: next.note } : next);
		lastFetch.set(key, Date.now());
		requestRender();
		return true;
	}

	// Only the provider on screen is worth a request.
	async function refresh(force: boolean): Promise<boolean> {
		const key = activeKey();
		return key ? await fetchProvider(key, force) : false;
	}

	// ---------- session totals (footer) ----------

	function sessionTotals(ctx: ExtensionContext): { tokens: number; cost: number } {
		let tokens = 0;
		let cost = 0;
		const add = (u: { totalTokens?: number; cost?: { total?: number } } | undefined) => {
			if (!u) return;
			tokens += num(u.totalTokens) ?? 0;
			cost += num(u.cost?.total) ?? 0;
		};
		for (const entry of ctx.sessionManager.getEntries()) {
			// Compacting and summarising a branch also cost tokens, and pi's own
			// footer counts them.
			if (entry.type === "compaction" || entry.type === "branch_summary") add(entry.usage);
			// Tool results carry the tokens tools spent on their own LLM calls.
			else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult"))
				add(entry.message.usage);
		}
		return { tokens, cost };
	}

	// ---------- output speed (footer) ----------

	// Estimate received output at four UTF-16 code units per token. Count only
	// streamed text, thinking (including summaries), and tool-call arguments,
	// never provider usage totals: those can include unseen reasoning.
	// Time from the first nonempty delta to message end, excluding initial wait.
	// Short replies are noisy, so omit them. Weight the last 10 accepted replies
	// by total estimated tokens over total time, not by averaging their speeds.
	const MIN_SPEED_MS = 500;
	const MIN_SPEED_TOKENS = 20;
	const SPEED_WINDOW = 10;
	let speedSamples: Array<{ tokens: number; ms: number }> = [];
	let firstDeltaAt: number | undefined;
	let streamedChars = 0;

	function clearSpeed(): void {
		speedSamples = [];
		stats.tps = undefined;
		resetSpeedTimer();
	}

	function resetSpeedTimer(): void {
		firstDeltaAt = undefined;
		streamedChars = 0;
	}

	function noteDelta(event: { type: string; delta?: string } | undefined): void {
		if (!event || !["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type)) return;
		if (typeof event.delta !== "string" || !event.delta.length) return;
		firstDeltaAt ??= Date.now();
		streamedChars += event.delta.length;
	}

	function recordSpeed(message: AssistantMessage): void {
		const start = firstDeltaAt;
		const tokens = streamedChars / 4;
		resetSpeedTimer();
		if (start === undefined || message.stopReason === "error" || message.stopReason === "aborted") return;
		const ms = Date.now() - start;
		if (ms < MIN_SPEED_MS || tokens < MIN_SPEED_TOKENS) return;
		speedSamples = [...speedSamples, { tokens, ms }].slice(-SPEED_WINDOW);
		const total = speedSamples.reduce((sum, x) => ({ tokens: sum.tokens + x.tokens, ms: sum.ms + x.ms }), { tokens: 0, ms: 0 });
		stats.tps = total.tokens / (total.ms / 1000);
	}

	// ---------- theme ----------

	// A stub theme (print mode, tests) may not carry these, so both are read
	// defensively, once, for every caller.
	function themeText(theme: Theme) {
		return {
			fg: (role: ThemeColor, s: string): string => theme?.fg?.(role, s) ?? s,
			bold: (s: string): string => theme?.bold?.(s) ?? s,
		};
	}

	// ---------- usage line (rendered inside the footer) ----------

	function usageLines(theme: Theme, width: number, providerLabel: string): string[] {
		if (width <= 0) return [];
		const { fg, bold } = themeText(theme);
		// Wrap notes that carry the login hint so its command stays complete. External notes
		// still truncate, so an unbounded error cannot fill the whole footer.
		const noteLine = (name: string, text: string): string[] => {
			const line = `${fg("accent", name)}  ${fg("muted", text)}`;
			return text.includes(TOKEN_EXPIRED_NOTE) ? wrapTextWithAnsi(line, width) : [truncate(line, width)];
		};

		// Only show the plan that matches the model in use. Providers with no usage
		// endpoint wired up (opencode, say) get a note, so a missing row is never
		// mistaken for a plan sitting at zero.
		const key = activeKey();
		if (!key) return providerLabel ? noteLine(providerLabel, "no usage endpoint") : [];
		const status = cache.get(key);
		if (!status) return [];
		if (status.rows.length === 0) return noteLine(key, plainFooterText(status.note ?? "no limits reported"));

		const plan = status.plan ? `${key} ${plainFooterText(status.plan)}` : key;
		const prefix = plan + "  ";
		const rows = status.rows.map(r => ({ ...r, label: plainFooterText(r.label) }));
		const labelPad = Math.max(...rows.map(r => visibleWidth(r.label)));
		// Padding labels into a column is worth it only while the columns are spare.
		// One long label ("gpt-reserve weekly") would otherwise indent every other
		// row past the point where the percentage still fits.
		const widestPct = Math.max(...rows.map(r => visibleWidth(pctText(r.pct))));
		const aligned = visibleWidth(prefix) + labelPad + 1 + widestPct <= width;
		// Continuation rows sit under the plan name while that is affordable; when it
		// is not, a 2-space indent buys back a dozen columns for the numbers.
		const indent = aligned ? " ".repeat(visibleWidth(prefix)) : "  ";
		const lines: string[] = [];
		const sep = " · ";
		rows.forEach((r, i) => {
			// Name rides on the first row; later rows align under it.
			const head = i === 0 ? bold(fg("accent", prefix)) : indent;
			const headWidth = i === 0 ? visibleWidth(prefix) : visibleWidth(indent);
			const pctPart = pctText(r.pct);
			// The number is the payload. Reserve its columns first, then let the
			// label have what is left, so a long label truncates instead of pushing
			// the percentage off the line.
			const labelBudget = Math.max(3, width - headWidth - visibleWidth(pctPart) - 1);
			const labelText = aligned ? padToWidth(r.label, labelPad) : r.label;
			const labelPart = (visibleWidth(labelText) > labelBudget ? truncate(labelText, labelBudget) : labelText) + " ";
			// The bar is decoration and the number is not, so the bar gives up its
			// columns first, and disappears rather than shrink to an unreadable stub.
			const barWidth = Math.min(BAR_WIDTH, width - headWidth - visibleWidth(labelPart) - visibleWidth(pctPart) - 2);
			const barPart = barWidth >= 3 ? `${fg("accent", bar(r.pct, barWidth))}  ` : "";
			const core = `${head}${fg("muted", labelPart)}${barPart}${fg("muted", pctPart)}`;
			const reset = formatReset(r);
			const resetText = reset ? fg("muted", reset) : "";
			if (resetText && visibleWidth(core) + visibleWidth(sep) + visibleWidth(resetText) <= width) {
				lines.push(core + sep + resetText);
				return;
			}
			lines.push(truncate(core, width));
			// Keep the whole reset text, even when it needs more than one line.
			// Use a smaller indent when the plan-name indent would force wrapping.
			if (resetText) {
				const resetIndent = visibleWidth(indent + resetText) <= width ? indent : width > 2 ? "  " : "";
				lines.push(...wrapTextWithAnsi(resetText, width - visibleWidth(resetIndent)).map(line => resetIndent + line));
			}
		});
		if (status.stale) lines.push(...noteLine(key, `showing last result · ${plainFooterText(status.stale)}`));
		return lines;
	}

	// ---------- footer ----------

	function unavailableFooter(width: number): string[] {
		return width > 0 ? [truncateToWidth(WARNING_MESSAGES.footer, width, "")] : [];
	}

	function installFooter(ctx: ExtensionContext): void {
		try {
			ctx.ui.setWidget("usage-limits", undefined); // usage now lives in the footer
		} catch {
			// Widget may not exist yet — fine.
		}
		try {
			ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
				requestRender = () => {
					try {
						tui.requestRender();
					} catch {
						// No TUI to redraw (RPC or print mode).
					}
				};
				return {
					invalidate() {},
					render(width: number): string[] {
						try {
							return renderFooter(theme, footerData, width);
						} catch {
							reportWarning("footer");
							return unavailableFooter(width);
						}
					},
				};
			});
		} catch {
			reportWarning("registration");
		}
	}

	function renderFooter(theme: Theme, footerData: ReadonlyFooterDataProvider, width: number): string[] {
		const { fg } = themeText(theme);
		const s = stats;

		const sep = fg("dim", " · ");
		const gap = 3;
		const minColumnWidth = 40;
		const useColumns = width >= minColumnWidth * 2 + gap;
		const leftWidth = useColumns ? Math.floor((width - gap) / 2) : width;
		const rightWidth = useColumns ? width - gap - leftWidth : width;

		// On wide terminals, each column gets half the available width. On narrow
		// terminals, each column gets the full width; the right group stacks below
		// the left one, left-aligned like everything else.
		const branch = footerData.getGitBranch();
		const locationParts = [plainFooterText(homeTilde(s.cwd ?? ""))];
		if (branch && branch !== "detached") locationParts.push(`branch ${plainFooterText(branch)}`);
		if (s.sessionName) locationParts.push(plainFooterText(s.sessionName));
		const pathLines = packLines(locationParts.map(p => fg("dim", p)), sep, rightWidth);

		// Session totals are on top of provider usage. Use one pastel blue for
		// everything, context included: no warning colours here.
		const leftStats: string[] = [];
		if (s.tokens > 0) leftStats.push(fg("dim", `${shortTokens(s.tokens)} tokens used`));
		if (s.cost > 0) leftStats.push(fg("dim", `$${s.cost.toFixed(2)}`));
		if (s.contextPercent !== undefined && s.contextWindow) {
			const pct = Math.round(s.contextPercent);
			leftStats.push(fg("dim", `context ${pct}% of ${shortTokens(s.contextWindow)}`));
		}
		const provider = s.provider ? plainFooterText(s.provider) : "";
		const modelInfo: string[] = [];
		if (s.model) {
			// The provider is worth naming only when more than one is logged in.
			const providers = footerData.getAvailableProviderCount();
			const model = plainFooterText(s.model);
			modelInfo.push(providers > 1 && provider ? `(${provider}) ${model}` : model);
			if (s.thinking) modelInfo.push(`thinking ${plainFooterText(s.thinking)}`);
			if (s.tps !== undefined) modelInfo.push(`~${Math.round(s.tps)} tok/s`);
		} else {
			modelInfo.push("no model");
		}

		const leftParts = leftStats.length ? leftStats : [fg("dim", "new chat")];
		const usage = usageLines(theme, leftWidth, provider);
		const leftLines = [...packLines(leftParts, sep, leftWidth), ...usage];
		const rightLines = [...pathLines, ...packLines(modelInfo.map(r => fg("dim", r)), sep, rightWidth)];
		const lines = useColumns
			? layoutColumns(leftLines, rightLines, leftWidth, rightWidth, gap)
			: [...leftLines, ...rightLines];
		const statuses = footerData.getExtensionStatuses();
		if (statuses?.size) {
			const statusLine = Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatus(text))
				.filter(text => text.length > 0)
				.join("  ");
			if (statusLine) lines.push(truncate(fg("dim", statusLine), width));
		}
		return lines;
	}

	// Extension statuses are already styled strings. Keep them on their existing
	// path so intentional SGR styling survives; this is not plain footer text.
	function sanitizeStatus(text: string): string {
		return String(text ?? "")
			.replace(/[\r\n\t\u2028\u2029]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	// Cut to terminal columns, not to characters: pi's helper keeps colour codes
	// whole and counts wide characters correctly.
	function truncate(s: string, width: number): string {
		if (width <= 0) return "";
		return truncateToWidth(s, width, "…");
	}

	function padToWidth(s: string, width: number): string {
		return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
	}

	// Lay `parts` out over as few lines as fit, keeping each segment whole and
	// joining with `sep`. A phone-width terminal wraps instead of losing the tail;
	// only a single segment too wide to stand alone is truncated.
	function packLines(parts: string[], sep: string, width: number): string[] {
		const lines: string[] = [];
		let cur = "";
		for (const part of parts) {
			// A themed empty string still carries colour codes, so the width decides
			// what is empty. An empty segment must not earn a separator.
			if (visibleWidth(part) === 0) continue;
			const candidate = cur ? cur + sep + part : part;
			if (visibleWidth(candidate) <= width) {
				cur = candidate;
				continue;
			}
			if (cur) lines.push(cur);
			cur = visibleWidth(part) <= width ? part : truncate(part, width);
		}
		if (cur) lines.push(cur);
		return lines;
	}

	// Keep both columns at their half-widths and bottom-align their content. This
	// keeps the model and thinking level in the bottom-right position, with the
	// path information above them.
	function layoutColumns(
		leftLines: string[],
		rightLines: string[],
		leftWidth: number,
		rightWidth: number,
		gap: number,
	): string[] {
		const rowCount = Math.max(leftLines.length, rightLines.length);
		const leftStart = rowCount - leftLines.length;
		const rightStart = rowCount - rightLines.length;
		return Array.from({ length: rowCount }, (_, index) => {
			const left = leftLines[index - leftStart] ?? "";
			const right = rightLines[index - rightStart] ?? "";
			if (!right) return left;

			// A line wider than its own column would make the padding negative, and
			// `repeat` throws on that, which would drop the whole footer. The columns
			// touch instead.
			const leftPadding = Math.max(0, leftWidth - visibleWidth(left));
			const rightPadding = Math.max(0, rightWidth - visibleWidth(right));
			return `${left}${" ".repeat(leftPadding + gap + rightPadding)}${right}`;
		});
	}

	// Snapshot the footer reads between events. Updated on every wired event.
	type FooterStats = {
		cwd?: string;
		sessionName?: string;
		tokens: number;
		cost: number;
		contextPercent?: number;
		contextWindow?: number;
		model?: string;
		provider?: string;
		thinking?: string;
		tps?: number;
	};
	const stats: FooterStats = { tokens: 0, cost: 0 };

	function updateSnapshot(ctx: ExtensionContext): void {
		try {
			const { tokens, cost } = sessionTotals(ctx);
			const cwd = ctx.sessionManager.getCwd?.() ?? stats.cwd;
			const sessionName = ctx.sessionManager.getSessionName?.();
			const usage = ctx.getContextUsage?.();
			const contextPercent = usage?.percent ?? undefined;
			const contextWindow = usage?.contextWindow ?? undefined;
			const model = ctx.model?.id;
			const provider = ctx.model?.provider;
			const thinking = ctx.thinkingLevel && ctx.model?.reasoning ? String(ctx.thinkingLevel) : undefined;
			Object.assign(stats, { tokens, cost, cwd, sessionName, contextPercent, contextWindow, model, provider, thinking });
		} catch {
			// Stale ctx — keep the last snapshot.
			reportWarning("snapshot");
		}
	}

	function updateSnapshotAndRender(ctx: ExtensionContext): void {
		updateSnapshot(ctx);
		requestRender();
	}

	// ---------- tool block headers ----------

	// A small tool title with its target path above each tool block. Only the call
	// renderer is wrapped; the built-in call body and result rendering stay in
	// place, so expand/collapse keeps working exactly as before.
	function safeToolTarget(args: ToolCallArgs): string {
		const partial = args as PartialToolArgs | null | undefined;
		const path = partial?.path ?? partial?.file_path;
		return typeof path === "string" && path.length > 0
			? path.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
			: "";
	}

	// A registered tool replaces Pi's own, so it must be built the way Pi builds
	// it: with the user's settings. Without them, shellCommandPrefix, shellPath,
	// and image auto-resize would silently stop applying. Project settings count
	// only when Pi trusts the project: shellCommandPrefix runs before every
	// command, so an untrusted repository must not be able to set it.
	function builtinToolOptions(ctx: ExtensionContext): { read?: object; bash?: object } {
		try {
			const projectTrusted = ctx.isProjectTrusted?.() === true;
			const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
			return {
				read: { autoResizeImages: settings.getImageAutoResize() },
				bash: { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() },
			};
		} catch {
			// A locked or unreadable settings file: the tools still work, without them.
			reportWarning("registration");
			return {};
		}
	}

	function installToolHeaders(ctx: ExtensionContext): void {
		// Built-in tools use different TypeBox schemas, so this table keeps one
		// permissive boundary while the renderer callback uses public ToolDefinition types.
		const factories: Array<[string, BuiltinToolFactory]> = [
			["read", createReadToolDefinition],
			["bash", createBashToolDefinition],
			["edit", createEditToolDefinition],
			["write", createWriteToolDefinition],
			["grep", createGrepToolDefinition],
			["find", createFindToolDefinition],
			["ls", createLsToolDefinition],
			["powershell", createPowerShellToolDefinition],
		];
		const options = builtinToolOptions(ctx);
		for (const [name, factory] of factories) {
			try {
				const builtin = factory(ctx.cwd, (options as Record<string, object | undefined>)[name]);
				pi.registerTool({
					...builtin,
					renderCall(args: ToolCallArgs, theme: Theme, context: ToolCallContext) {
						const container = new Container();
						const target = safeToolTarget(args);
						container.addChild(new Text(themeText(theme).fg("dim", `→ using ${name}${target ? ` — ${target}` : ""}`), 0, 0));
						try {
							// Pi remembers our wrapper, but the built-in renderer must receive
							// its own previous component (Text, Box, etc.), not that wrapper.
							const previous = context?.lastComponent;
							const inner = builtin.renderCall?.(args, theme, {
								...context,
								lastComponent: previous instanceof Container ? previous.children[1] : undefined,
							});
							if (inner) container.addChild(inner);
						} catch {
							reportWarning("tool-render");
							// Built-in call rendering failed — the header alone still shows.
						}
						return container;
					},
				});
			} catch {
				reportWarning("registration");
				// Tool unavailable in this environment — skip it.
			}
		}
	}

	// ---------- assistant block headers ----------

	// A small italic title above assistant text and thinking blocks. The
	// transformer is display-only: the session file and the LLM context keep
	// the original text. User messages are left alone.
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (!markdown.trim()) return markdown;
		if (messageType === "assistant") return `*✦ reply*\n\n${markdown}`;
		if (messageType === "assistant-thinking") return `*… thinking*\n\n${markdown}`;
		return markdown;
	});

	// ---------- wiring ----------

	installAutoResume(pi, async ctx => {
		const key = ctx.model ? PROVIDER_KEYS[ctx.model.provider] : undefined;
		if (!key) return undefined;
		// A running fetch (a footer refresh after a turn or a sent message) may have
		// started before the limit was hit. Let it finish, then fetch again, so
		// old data is never mistaken for a fresh reset.
		while (inFlight.has(key)) await inFlight.get(key);
		return await fetchProvider(key, true) ? cache.get(key) : undefined;
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		warningContext = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		warningContext = ctx;
		sessionActive = true;
		updateSnapshot(ctx);
		clearSpeed();
		installFooter(ctx);
		installToolHeaders(ctx);
		if (ctx.mode === "tui") {
			// This widget factory is also the only way to receive the live TUI.
			ctx.ui.setWidget("apple-pi-previous-message", (tui, theme) => {
				patchCopyReflow(tui, outputPad);
				return createPreviousMessageWidget(tui, theme, () => ctx.ui.notify("Previous-message navigation is unavailable in this Pi layout.", "warning"));
			}, { placement: "aboveEditor" });
		}
		// Do not hold up the session start for a web call.
		void refresh(true);
	});

	pi.on("message_start", event => {
		if (event.message?.role === "assistant") resetSpeedTimer();
	});

	pi.on("message_update", event => {
		if (event.message?.role === "assistant") noteDelta(event.assistantMessageEvent);
	});

	// User sent a message: refresh footer numbers, and usage too (at most once a
	// minute), since a window may have reset while idle. A finished reply sets
	// the speed.
	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role === "assistant") {
			recordSpeed(event.message);
			requestRender();
			return;
		}
		if (event.message?.role !== "user") return;
		updateSnapshotAndRender(ctx);
		void refresh(false);
	});

	// Run settled: refetch provider data (at most once a minute) and render.
	pi.on("agent_settled", async (_event, ctx) => {
		updateSnapshotAndRender(ctx);
		await refresh(false);
	});

	// Each turn's tokens, cost, and context land in the session here, so the
	// footer keeps up during a long run instead of waiting for it to settle.
	// Usage follows too, at most once a minute. The fetch does not hold up the run.
	pi.on("turn_end", async (_event, ctx) => {
		updateSnapshotAndRender(ctx);
		void refresh(false);
	});

	// Model switch swaps which plan row is shown and the footer's right side.
	// The last speed belongs to the old model.
	pi.on("model_select", async (_event, ctx) => {
		clearSpeed();
		updateSnapshotAndRender(ctx);
		// A different provider may have no data in the cache yet.
		await refresh(false);
	});

	// Thinking level sits on the right of the footer too.
	pi.on("thinking_level_select", async (_event, ctx) => {
		updateSnapshotAndRender(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		updateSnapshotAndRender(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		updateSnapshotAndRender(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		clearSpeed();
		updateSnapshotAndRender(ctx);
	});

	pi.registerCommand("usage", {
		description: "Refresh provider usage limits footer",
		handler: async (_args, ctx) => {
			updateSnapshot(ctx);
			const key = activeKey();
			const fetched = await refresh(true);
			try {
				ctx.ui.notify(
					fetched
						? "Usage limits updated"
						: key
							? "A usage refresh is already running"
							: "This model's provider has no usage endpoint",
					"info",
				);
			} catch {
				// ctx went stale mid-refresh (session replaced) — not fatal.
			}
		},
	});
}
