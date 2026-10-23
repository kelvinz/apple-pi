// Run from the repository root: pnpm test
// Uses Pi's installed jiti compiler and TUI helpers. Auth and HTTP are mocked.
// Pi is found through `pnpm root -g` and `npm root -g`, or set PI_PACKAGE_DIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const packagePath = "@earendil-works/pi-coding-agent/package.json";
const globalRoots = ["pnpm", "npm"].flatMap(cmd => {
	try { return [execFileSync(cmd, ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()]; } catch { return []; }
});
const installedPackage = [
	process.env.PI_PACKAGE_DIR && join(process.env.PI_PACKAGE_DIR, "package.json"),
	...globalRoots.flatMap(root => [join(root, packagePath), ...(existsSync(root) ? readdirSync(root) : []).map(dir => join(root, dir, "node_modules", packagePath))]),
].find(path => path && existsSync(path));
assert.ok(installedPackage, "Pi must be installed globally with pnpm or npm, or PI_PACKAGE_DIR must point at it");
const requirePi = createRequire(realpathSync(installedPackage));
const { createJiti } = requirePi("jiti");
const tui = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")));
const sourcePath = fileURLToPath(new URL("../extensions/apple-pi.ts", import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false });
const compiled = jiti.transform({ source: readFileSync(sourcePath, "utf8"), filename: sourcePath, ts: true });
const resetAt = new Date(2030, 9, 6, 18, 30).getTime();
const now = resetAt - (3 * 3600 + 42 * 60) * 1000;
const hour = 3600;
const day = 24 * hour;

// `state.status` is the HTTP status every mocked request returns; tests change it mid-run.
function loadExtension(responses = {}, state = { status: 200 }, clock = {}, env = {}) {
	const exports = {};
	const requests = [];
	const sentHeaders = [];
	const piModule = {
		getAgentDir: () => "/mock-agent",
		UserMessageComponent: class {},
	};
	runInNewContext(compiled, {
		exports,
		module: { exports },
		require(name) {
			if (name === "@earendil-works/pi-coding-agent") return piModule;
			if (name === "@earendil-works/pi-tui") return tui;
			if (name === "node:fs") return {
				readFileSync: () => JSON.stringify({
					// A saved reference, as Pi stores for env-var/credential-command
					// keys: this raw text must never reach a provider.
					zai: { type: "api_key", key: "${ZAI_API_KEY}" },
					"openai-codex": { type: "oauth", access: "test", accountId: "test" },
				}),
			};
			if (name === "node:path") return requirePi(name);
			throw new Error(`Unexpected import: ${name}`);
		},
		Date: class extends Date { static now() { return clock.now?.() ?? now; } },
		Intl, Buffer, Error, AbortController, AbortSignal: clock.AbortSignal ?? AbortSignal, setImmediate,
		setTimeout: clock.setTimeout ?? setTimeout,
		clearTimeout: clock.clearTimeout ?? clearTimeout,
		process: { env },
		fetch: async (url, options) => {
			requests.push(url);
			sentHeaders.push({ url, headers: options?.headers });
			assert.ok(Object.hasOwn(responses, url), `Unexpected HTTP request: ${url}`);
			await state.beforeResponse?.(options);
			return { ok: state.status >= 200 && state.status < 300, status: state.status, json: async () => responses[url] };
		},
	});
	assert.equal(exports.__JITI_ERROR__, undefined, "The extension must compile");
	return { ...exports, requests, sentHeaders };
}

const { formatReset, reflowText } = loadExtension();
const row = (windowSeconds, stamp = resetAt) => ({ label: "test", resetAt: stamp, windowSeconds });

test("hourly windows show local 24-hour time without a date", () => {
	assert.equal(formatReset(row(5 * hour), now), "resets 3h 42m (18:30)");
	assert.equal(formatReset(row(23 * hour), now), "resets 3h 42m (18:30)");
});

test("daily, weekly, monthly, and unknown windows always show the date", () => {
	for (const duration of [day, 7 * day, 30 * day, undefined, 0, -1]) {
		assert.equal(formatReset(row(duration), now), "resets 3h 42m (Sun 6 Oct, 18:30)");
	}
});

test("window length, not countdown length, selects the date", () => {
	assert.equal(formatReset(row(7 * day), resetAt - 60_000), "resets 1m 00s (Sun 6 Oct, 18:30)");
	assert.equal(formatReset(row(5 * hour), resetAt - 2 * day * 1000), "resets 2d 0h (18:30)");
});

test("hourly resets across midnight still show only time, with midnight as 00:00", () => {
	const midnight = new Date(2030, 9, 7, 0, 0).getTime();
	assert.equal(formatReset(row(5 * hour, midnight), midnight - 2 * hour * 1000), "resets 2h 0m (00:00)");
	const nextDay = midnight + 30 * 60 * 1000;
	assert.equal(formatReset(row(5 * hour, nextDay), midnight - hour * 1000), "resets 1h 30m (00:30)");
});

test("the countdown retains two units, seconds, and floor rounding", () => {
	assert.equal(formatReset(row(5 * hour), resetAt - 2_527_999), "resets 42m 07s (18:30)");
	assert.equal(formatReset(row(7 * day), resetAt - (2 * day + 5 * hour) * 1000), "resets 2d 5h (Sun 6 Oct, 18:30)");
	assert.equal(formatReset(row(5 * hour), resetAt - 999), "resets now (18:30)");
});

test("passed resets keep their time; missing or invalid timestamps show no reset", () => {
	assert.equal(formatReset(row(5 * hour), resetAt), "resets now (18:30)");
	assert.equal(formatReset(row(7 * day), resetAt + 60_000), "resets now (Sun 6 Oct, 18:30)");
	for (const stamp of [undefined, NaN, Infinity, 1e20]) {
		assert.equal(formatReset({ label: "test", resetAt: stamp }, now), "");
	}
});

const codexWindow = duration => ({ limit_window_seconds: duration, used_percent: 25, reset_at: resetAt / 1000 });
const fixtures = {
	"openai-codex": {
		url: "https://chatgpt.com/backend-api/wham/usage",
		response: {
			plan_type: "plus",
			rate_limit: { primary_window: codexWindow(5 * hour), secondary_window: codexWindow(7 * day) },
			additional_rate_limits: [{ limit_name: "luna reserve", rate_limit: { primary_window: codexWindow(5 * hour), secondary_window: codexWindow(7 * day) } }],
		},
		stamps: ["18:30", "Sun 6 Oct, 18:30", "18:30", "Sun 6 Oct, 18:30"],
	},
	zai: {
		url: "https://api.z.ai/api/monitor/usage/quota/limit",
		response: { data: { level: "test", limits: [
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 3, number: 24, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 4, number: 1, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 5, number: 1, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 99, percentage: 25, nextResetTime: resetAt },
			{ type: "TOKENS_LIMIT", unit: 3, number: 2, percentage: 0 },
		] } },
		stamps: ["18:30", ...Array(5).fill("Sun 6 Oct, 18:30")],
	},
};

async function createFooter(provider, theme, status = 200, options = {}) {
	// Providers without a fixture have no usage endpoint, so nothing is requested.
	const fixture = fixtures[provider];
	const state = { status };
	const extension = loadExtension({ ...(fixture ? { [fixture.url]: fixture.response } : {}), ...options.responses }, state, options.clock, options.env);
	const events = new Map();
	const commands = new Map();
	const tools = [];
	const toolRenderers = [];
	const prompts = [];
	const entries = [];
	const statuses = new Map();
	let footer;
	extension.default({
		on: (name, handler) => {
			const previous = events.get(name);
			events.set(name, previous ? async (...args) => {
				const result = await previous(...args);
				return await handler(...args) ?? result;
			} : handler);
		},
		registerTool: tool => tools.push(tool),
		registerToolRenderer: resolver => toolRenderers.push(resolver),
		registerCommand: (name, command) => commands.set(name, command),
		registerMarkdownTransformer() {},
		events: { emit() {} },
		sendUserMessage: text => prompts.push(text),
		sendMessage: message => entries.push({ type: "custom_message", ...asPlain(message) }),
	});
	const notices = [];
	const apiKeyCalls = [];
	const ctx = {
		mode: options.mode ?? "print", cwd: "/mock", hasUI: true, isIdle: () => true,
		model: { id: "test", provider },
		modelRegistry: {
			getApiKeyForProvider: async requested => {
				apiKeyCalls.push(requested);
				if (options.zaiApiKey instanceof Error) throw options.zaiApiKey;
				if (requested !== "zai") return undefined;
				// null means Pi has no credential for zai.
				if (options.zaiApiKey === null) return undefined;
				return options.zaiApiKey ?? "test";
			},
		},
		sessionManager: { getEntries: () => entries, getCwd: () => "/mock", getSessionId: () => "footer-thread" },
		ui: {
			setWidget(_key, factory) {
				if (options.copyTui && typeof factory === "function") factory(options.copyTui, theme);
			},
			setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
			notify: (message, level) => notices.push([message, level]),
			setFooter(factory) {
				footer = factory({ requestRender() {} }, theme, {
					getGitBranch: () => undefined,
					getAvailableProviderCount: () => 1,
					getExtensionStatuses: () => statuses,
				});
			},
		},
	};
	await events.get("session_start")({}, ctx);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(extension.requests.length, options.expectRequests ?? (fixture ? 1 : 0));
	return { footer, fixture, events, commands, ctx, entries, state, tools, toolRenderers, notices, prompts, requests: extension.requests, sentHeaders: extension.sentHeaders, apiKeyCalls };
}

const plainTheme = { fg: (_, text) => text, bold: text => text };
const plainText = footer => footer.render(240).map(tui.stripTerminalSequences).join(" ");

for (const provider of Object.keys(fixtures)) {
	test(`${provider}: provider parsing, extra buckets, and width-safe reset wrapping`, async () => {
		for (const styled of [false, true]) {
			const theme = {
				fg: (_, text) => styled ? `\x1b[34m${text}\x1b[39m` : text,
				bold: text => styled ? `\x1b[1m${text}\x1b[22m` : text,
			};
			const { footer, fixture, events, ctx, requests } = await createFooter(provider, theme);
			for (const width of [0, 1, 2, 10, 20, 32, 40, 60, 82, 83, 100, 160, 240]) {
				const lines = footer.render(width);
				assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `Overflow at width ${width}`);
				if (width >= 20) {
					const plain = lines.map(tui.stripTerminalSequences).join(" ");
					const stamps = [...plain.matchAll(/\((?:Sun\s+6\s+Oct,\s+)?18:30\)/g)].map(match => match[0].slice(1, -1).replace(/\s+/g, " "));
					assert.deepEqual(stamps, fixture.stamps, `Missing reset text at width ${width}`);
				}
			}
			const wide = footer.render(240).map(tui.stripTerminalSequences).join(" ");
			if (provider === "openai-codex") assert.ok(wide.includes("luna reserve"));
			if (provider === "zai") assert.ok(wide.includes("100% left"));
			await events.get("agent_settled")({}, ctx);
			assert.equal(requests.length, 1, "The existing one-minute fetch gap stays in place");
		}
	});

	test(`${provider}: expired-token notes keep the complete login command on narrow terminals`, async () => {
		for (const styled of [false, true]) {
			const theme = {
				fg: (_, text) => styled ? `\x1b[34m${text}\x1b[39m` : text,
				bold: text => text,
			};
			const { footer } = await createFooter(provider, theme, 401);
			for (const width of [16, 20, 24, 32, 40, 60, 120]) {
				const lines = footer.render(width);
				const plain = lines.map(tui.stripTerminalSequences);
				assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `Overflow at width ${width}`);
				assert.ok(plain.some(line => line.includes("/login")), `Missing complete /login command at width ${width}`);
				assert.ok(plain.join(" ").replace(/\s+/g, " ").includes("token expired"), `Missing reason at width ${width}`);
			}
		}
	});
}

test("Codex: a ten-second timeout keeps cached usage and a successful retry clears the warning", async () => {
	let signal;
	const timeouts = [];
	const clock = { AbortSignal: { timeout(ms) {
		timeouts.push(ms);
		signal = new AbortController();
		return signal.signal;
	} } };
	const { footer, commands, ctx, state } = await createFooter("openai-codex", plainTheme, 200, { clock });
	assert.ok(plainText(footer).includes("75% left"));
	state.beforeResponse = ({ signal }) => new Promise((resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	const pending = commands.get("usage").handler("", ctx);
	assert.deepEqual(timeouts, [10_000, 10_000]);
	const error = new Error("The operation was aborted due to timeout");
	error.name = "TimeoutError";
	signal.abort(error);
	await pending;
	assert.ok(plainText(footer).includes("75% left"));
	assert.ok(plainText(footer).includes("showing last result · Usage request timed out; try /usage"));
	state.beforeResponse = undefined;
	await commands.get("usage").handler("", ctx);
	assert.ok(!plainText(footer).includes("showing last result"));
});

test("zai: a failed refresh keeps the last good rows and says they are old", async () => {
	const { footer, commands, ctx, state } = await createFooter("zai", plainTheme);
	assert.ok(plainText(footer).includes("100% left"));
	state.status = 500;
	await commands.get("usage").handler("", ctx);
	const text = plainText(footer);
	assert.ok(text.includes("100% left"), "The last good rows stay");
	assert.ok(text.includes("showing last result · error 500"));
	state.status = 401;
	await commands.get("usage").handler("", ctx);
	for (const width of [20, 32, 60]) {
		const lines = footer.render(width);
		assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `Overflow at width ${width}`);
		assert.ok(lines.map(tui.stripTerminalSequences).some(line => line.includes("/login")), `Missing /login at width ${width}`);
	}
	state.status = 200;
	await commands.get("usage").handler("", ctx);
	assert.ok(!plainText(footer).includes("showing last result"), "A good refresh clears the note");
});

// Z.ai credentials come from Pi's resolver, so saved references work and the
// stored reference text itself is never sent to the provider.
test("zai auth: a resolved literal key is sent as the bearer token", async () => {
	const run = await createFooter("zai", plainTheme, 200, { zaiApiKey: "resolved-literal-key" });
	assert.ok(plainText(run.footer).includes("100% left"));
	assert.deepEqual(run.apiKeyCalls, ["zai"], "The key is asked from Pi's registry, for zai only");
	assert.equal(run.sentHeaders.length, 1);
	assert.equal(run.sentHeaders[0].headers.authorization, "Bearer resolved-literal-key");
	assert.notEqual(run.sentHeaders[0].headers.authorization, "Bearer ${ZAI_API_KEY}");
});

test("zai auth: environment references and credential commands resolve through Pi", async () => {
	for (const resolved of ["env-resolved-key", "command-resolved-key"]) {
		const run = await createFooter("zai", plainTheme, 200, { zaiApiKey: resolved });
		assert.equal(run.sentHeaders[0].headers.authorization, `Bearer ${resolved}`);
		// The unresolved reference stored in auth.json is never the token.
		assert.ok(run.sentHeaders.every(sent => !JSON.stringify(sent.headers).includes("ZAI_API_KEY")));
	}
});

test("zai auth: missing credentials mean no request and a not-set-up note", async () => {
	const run = await createFooter("zai", plainTheme, 200, { zaiApiKey: null, expectRequests: 0 });
	assert.equal(run.requests.length, 0);
	assert.deepEqual(run.apiKeyCalls, ["zai"]);
	assert.ok(plainText(run.footer).includes("zai"), "The provider is still named");
	assert.ok(plainText(run.footer).includes("not set up"));
});

test("zai auth: a failing resolver keeps the last good rows as stale", async () => {
	const options = { zaiApiKey: "good-key" };
	const run = await createFooter("zai", plainTheme, 200, options);
	assert.ok(plainText(run.footer).includes("100% left"));
	options.zaiApiKey = new Error("credential command failed");
	await run.commands.get("usage").handler("", run.ctx);
	const text = plainText(run.footer);
	assert.ok(text.includes("100% left"), "The last good rows stay");
	assert.ok(text.includes("showing last result · credential command failed"));
	// A later successful lookup clears the stale note.
	options.zaiApiKey = "good-key";
	await run.commands.get("usage").handler("", run.ctx);
	assert.ok(!plainText(run.footer).includes("showing last result"));
});

test("zai auth: a key Pi stops resolving replaces the rows with a not-set-up note", async () => {
	// Pi 1.3.0's getApiKeyForProvider catches resolution errors and returns
	// undefined, so a failing credential command arrives here as no key.
	const options = { zaiApiKey: "good-key" };
	const run = await createFooter("zai", plainTheme, 200, options);
	assert.ok(plainText(run.footer).includes("100% left"));
	options.zaiApiKey = null;
	await run.commands.get("usage").handler("", run.ctx);
	const text = plainText(run.footer);
	assert.ok(text.includes("not set up"));
	assert.ok(!text.includes("100% left"), "Rows Pi can no longer authenticate are not shown as current");
	assert.equal(run.requests.length, 1, "No request is sent without a key");
});

test("zai auth: a provider switch during a pending resolution caches under the requested provider", async () => {
	let resolveZai;
	const options = { zaiApiKey: new Promise(resolve => { resolveZai = resolve; }) };
	const codexFixture = fixtures["openai-codex"];
	const run = await createFooter("zai", plainTheme, 200, {
		...options,
		expectRequests: 0,
		responses: { [codexFixture.url]: codexFixture.response },
	});
	assert.equal(run.requests.length, 0, "The zai request waits for its key");
	// The model switches to Codex while the zai key is still resolving.
	run.ctx.model = { id: "test", provider: "openai-codex" };
	await run.events.get("model_select")({}, run.ctx);
	assert.ok(plainText(run.footer).includes("75% left"), "Codex data shows while zai is pending");
	resolveZai("late-zai-key");
	await new Promise(resolve => setImmediate(resolve));
	// The late zai response is cached under zai, not under the provider on screen.
	assert.equal(run.requests.length, 2);
	assert.equal(run.sentHeaders.find(sent => sent.url.includes("api.z.ai")).headers.authorization, "Bearer late-zai-key");
	run.ctx.model = { id: "test", provider: "zai" };
	await run.events.get("model_select")({}, run.ctx);
	assert.equal(run.requests.length, 2, "Switching back reuses the cached zai rows");
	assert.ok(plainText(run.footer).includes("100% left"));
});

test("providers without a usage endpoint make no request", async () => {
	for (const provider of ["anthropic", "zai-coding-cn"]) {
		const { footer, requests } = await createFooter(provider, plainTheme);
		assert.ok(plainText(footer).includes("no usage endpoint"), provider);
		assert.equal(requests.length, 0);
	}
});

// A plain render context for tool renderers: lastComponent is the slot's previous component.
function renderContext(overrides = {}) {
	return { args: {}, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/mock", executionStarted: false, ...overrides };
}
const headerLine = component => component.render(100).map(line => tui.stripTerminalSequences(line).trim());

test("tool headers: no tools are registered; one resolver decorates only named tools that render calls", async () => {
	const run = await createFooter("zai", plainTheme);
	assert.equal(run.tools.length, 0, "registerTool is never called");
	assert.equal(run.toolRenderers.length, 1, "Exactly one renderer resolver");
	const resolver = run.toolRenderers[0];
	const base = { renderCall() {}, renderResult() {}, renderShell() {} };
	assert.notEqual(resolver("bash", () => base).renderCall, base.renderCall, "bash is decorated");
	assert.notEqual(resolver("powershell", () => base).renderCall, base.renderCall, "powershell is decorated");
	assert.equal(resolver("mcp__server__tool", () => base), base, "Other tools pass through as the same object");
	const noCall = { renderResult: base.renderResult, renderShell: base.renderShell };
	assert.equal(resolver("bash", () => noCall), noCall, "No call renderer below means no decoration");
	assert.equal(resolver("bash", () => undefined), undefined, "Tools without renderers stay unknown");
});

test("tool headers: the renderer below is called, and result and shell rendering pass through unchanged", async () => {
	const run = await createFooter("zai", plainTheme);
	const resolver = run.toolRenderers[0];
	const seen = [];
	const inner = new tui.Text("$ echo hi", 0, 0);
	const renderResult = () => "result";
	const renderShell = () => "shell";
	const wrapped = resolver("bash", () => ({
		renderCall(args, theme, context) { seen.push({ args, theme, context }); return inner; },
		renderResult,
		renderShell,
	}));
	assert.equal(wrapped.renderResult, renderResult, "Result rendering is the same function");
	assert.equal(wrapped.renderShell, renderShell, "Shell rendering is the same function");
	const args = { command: "echo hi" };
	const context = renderContext();
	const lines = headerLine(wrapped.renderCall(args, plainTheme, context));
	assert.deepEqual(seen.map(call => call.args), [args], "The renderer below sees the same arguments");
	assert.equal(seen[0].theme, plainTheme);
	assert.equal(seen[0].context.lastComponent, undefined, "No previous component stays undefined");
	assert.deepEqual(lines, ["→ using bash", "$ echo hi"]);
});

test("tool headers: titles escape control characters in paths", async () => {
	const run = await createFooter("zai", plainTheme);
	const resolver = run.toolRenderers[0];
	const wrapped = resolver("read", () => ({ renderCall: () => new tui.Text("body", 0, 0) }));
	const lines = headerLine(wrapped.renderCall({ path: "a\u001bb\u007fc" }, plainTheme, renderContext()));
	assert.deepEqual(lines, ["→ using read — a\\u001bb\\u007fc", "body"]);
});

test("tool headers: the renderer below receives its own previous inner component", async () => {
	const run = await createFooter("zai", plainTheme);
	const resolver = run.toolRenderers[0];
	const seen = [];
	const wrapped = resolver("edit", () => ({ renderCall: (args, theme, context) => { seen.push(context.lastComponent); return new tui.Text("edit", 0, 0); } }));
	// A previous render's wrapper: header above, the renderer's own component below.
	const previousInner = new tui.Text("previous inner", 0, 0);
	const previous = new tui.Container();
	previous.addChild(new tui.Text("→ using edit", 0, 0));
	previous.addChild(previousInner);
	wrapped.renderCall({ file_path: "a.ts" }, plainTheme, renderContext({ lastComponent: previous }));
	wrapped.renderCall({ file_path: "a.ts" }, plainTheme, renderContext({ lastComponent: previousInner }));
	assert.deepEqual(seen, [previousInner, undefined], "Only the wrapper's second child is reused; foreign components are not");
});

test("tool headers: a renderer below that throws keeps the header and warns once", async () => {
	const run = await createFooter("zai", plainTheme);
	const resolver = run.toolRenderers[0];
	const wrapped = resolver("write", () => ({ renderCall() { throw new Error("renderer changed"); } }));
	for (let i = 0; i < 2; i++) {
		const lines = headerLine(wrapped.renderCall({ path: "out.txt" }, plainTheme, renderContext()));
		assert.deepEqual(lines, ["→ using write — out.txt"], "The header alone still shows");
	}
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(run.notices, [["apple-pi tool renderer unavailable", "warning"]]);
});

test("tool headers: a remote tool loaded before or after apple-pi keeps its execute function", async t => {
	// Use Pi's real extension loader, tool merge, and renderer resolution, so the
	// registration order in the assertion is Pi's, not a mock's.
	const piRoot = realpathSync(installedPackage);
	const { loadExtensionFromFactory, createExtensionRuntime } = await import(new URL("./dist/core/extensions/loader.js", pathToFileURL(piRoot)));
	const { ExtensionRunner } = await import(new URL("./dist/core/extensions/runner.js", pathToFileURL(piRoot)));
	const { withBuiltInRenderers } = await import(new URL("./dist/core/tools/renderers/index.js", pathToFileURL(piRoot)));
	// Pi's built-in renderers style through its global theme, which starts uninitialized.
	(await import(new URL("./dist/modes/interactive/theme/theme.js", pathToFileURL(piRoot)))).initTheme("system");
	const remoteExecutions = [];
	const remoteExecute = async () => { remoteExecutions.push("ran"); return { output: "remote" };
	};
	const remoteFactory = pi => {
		pi.registerTool({
			name: "bash",
			description: "runs on a remote machine",
			parameters: { type: "object", properties: { command: { type: "string" } } },
			execute: remoteExecute,
		});
	};
	const { default: applePiFactory } = loadExtension();
	for (const [first, second, label] of [[remoteFactory, applePiFactory, "remote first"], [applePiFactory, remoteFactory, "apple-pi first"]]) {
		const extensions = [];
		for (const factory of [first, second]) {
			extensions.push(await loadExtensionFromFactory(factory, "/mock", undefined, createExtensionRuntime()));
		}
		const applePi = extensions.find(ext => ext.tools.size === 0);
		const remote = extensions.find(ext => ext.tools.size > 0);
		t.assert.ok(applePi && remote, label);
		assert.equal(applePi.tools.size, 0, `${label}: apple-pi registers no tools`);
		// Pi keeps the first registration of a name; apple-pi must not take part.
		const merged = ExtensionRunner.prototype.getAllRegisteredTools.call({ extensions });
		const bash = merged.find(tool => tool.definition.name === "bash");
		assert.equal(bash?.definition.execute, remoteExecute, `${label}: the remote execute function stays selected`);
		// Decoration is display-only: the title renders above the call body.
		const resolved = ExtensionRunner.prototype.resolveToolRenderers.call({ extensions }, "bash", () => withBuiltInRenderers("bash", remote.tools.get("bash").definition));
		const lines = resolved.renderCall({ command: "echo hi" }, plainTheme, renderContext()).render(80).map(line => tui.stripTerminalSequences(line).trim());
		assert.ok(lines.some(line => line.startsWith("→ using bash")), `${label}: title shows`);
		assert.ok(lines.some(line => line.includes("echo hi")), `${label}: the call body still renders`);
	}
	assert.deepEqual(remoteExecutions, [], "No shell command is executed");
});

test("tokens and cost follow each turn without waiting for the run to settle", async () => {
	const { footer, events, ctx, entries } = await createFooter("zai", plainTheme);
	assert.ok(plainText(footer).includes("new chat"));
	entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 1500, cost: { total: 0.5 } } } });
	await events.get("turn_end")({}, ctx);
	const text = plainText(footer);
	assert.ok(text.includes("1.5k tokens used"));
	assert.ok(text.includes("$0.50"));
});

test("usage refreshes on sent messages and during a run, at most once a minute", async () => {
	const clock = { t: now, now: () => clock.t };
	const { events, ctx, requests } = await createFooter("zai", plainTheme, 200, { clock });
	const settle = () => new Promise(resolve => setImmediate(resolve));
	assert.equal(requests.length, 1);
	for (let i = 0; i < 5; i++) {
		clock.t += 10_000;
		await events.get("turn_end")({}, ctx);
		await settle();
	}
	assert.equal(requests.length, 1);
	clock.t += 11_000;
	await events.get("turn_end")({}, ctx);
	await settle();
	assert.equal(requests.length, 2);
	clock.t += 61_000;
	await events.get("message_end")({ message: { role: "user" } }, ctx);
	await settle();
	assert.equal(requests.length, 3);
});

// Streams one assistant reply: `waitMs` before the first delta, `streamMs` after it.
async function streamReply(events, ctx, clock, { waitMs = 0, streamMs, chars = 2400, usage, delta = "text_delta", stopReason = "stop" }) {
	const message = { role: "assistant", usage, stopReason };
	await events.get("message_start")({ message }, ctx);
	clock.t += waitMs;
	await events.get("message_update")({ message, assistantMessageEvent: { type: delta, delta: "a".repeat(chars) } }, ctx);
	await events.get("message_update")({ message, assistantMessageEvent: { type: "text_delta", delta: "" } }, ctx);
	clock.t += streamMs;
	await events.get("message_end")({ message }, ctx);
}

test("output speed: timed from the first delta, shown after the model", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("zai", plainTheme, 200, { clock });
	assert.ok(!plainText(footer).includes("tok/s"));
	await streamReply(events, ctx, clock, { waitMs: 5000, streamMs: 2000, usage: { output: 600 } });
	assert.ok(plainText(footer).includes("test · ~300 tok/s"));
});

test("output speed: short, failed, and aborted replies keep the last good value", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("zai", plainTheme, 200, { clock });
	await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 600 } });
	await streamReply(events, ctx, clock, { streamMs: 100, usage: { output: 600 } });
	await streamReply(events, ctx, clock, { streamMs: 2000, chars: 40, usage: { output: 10 } });
	await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 100 }, stopReason: "error" });
	await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 100 }, stopReason: "aborted" });
	assert.ok(plainText(footer).includes("300 tok/s"));
});

test("output speed: Codex summaries count only received text, not hidden reasoning", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("openai-codex", plainTheme, 200, { clock });
	for (const delta of ["text_delta", "thinking_delta", "toolcall_delta"]) {
		await streamReply(events, ctx, clock, { waitMs: 5000, streamMs: 1000, chars: 400, usage: { output: 5000, reasoning: 4900 }, delta });
		assert.ok(plainText(footer).includes("~100 tok/s"));
	}
	// Provider totals are not needed at all.
	await streamReply(events, ctx, clock, { streamMs: 1000, chars: 400 });
	assert.ok(plainText(footer).includes("~100 tok/s"));
});

test("output speed: the last 10 replies are averaged by tokens over time", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("zai", plainTheme, 200, { clock });
	for (let i = 0; i < 10; i++) await streamReply(events, ctx, clock, { streamMs: 2000, chars: 800, usage: { output: 200 } });
	assert.ok(plainText(footer).includes("100 tok/s"));
	// (9 × 200 + 600) tokens over 20 s.
	await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 600 } });
	assert.ok(plainText(footer).includes("120 tok/s"));
	for (let i = 0; i < 9; i++) await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 600 } });
	assert.ok(plainText(footer).includes("300 tok/s"));
});

test("output speed: empty and non-output events do not start timing or double-count text", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("openai-codex", plainTheme, 200, { clock });
	const message = { role: "assistant", stopReason: "stop" };
	const update = event => events.get("message_update")({ message, assistantMessageEvent: event }, ctx);
	await events.get("message_start")({ message }, ctx);
	await update({ type: "text_delta", delta: "" });
	await update({ type: "thinking_start" });
	clock.t += 5000;
	for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) {
		await update({ type, delta: "a".repeat(400) });
	}
	await update({ type: "text_end", delta: "a".repeat(1200) });
	clock.t += 1000;
	await events.get("message_end")({ message }, ctx);
	assert.ok(plainText(footer).includes("~300 tok/s"));
	await streamReply(events, ctx, clock, { streamMs: 1000, chars: 0, usage: { output: 9999 } });
	assert.ok(plainText(footer).includes("~300 tok/s"), "No received text means no new sample");
});

test("output speed: a model switch clears the old model's speed", async () => {
	const clock = { t: now, now: () => clock.t };
	const { footer, events, ctx } = await createFooter("zai", plainTheme, 200, { clock });
	await streamReply(events, ctx, clock, { streamMs: 2000, usage: { output: 600 } });
	await events.get("model_select")({}, ctx);
	assert.ok(!plainText(footer).includes("tok/s"));
});

// reflowText joins rows the transcript wrapped, and nothing else. Room is 20 columns.
test("reflow joins a forced wrap and keeps rows that could have fit", () => {
	assert.equal(reflowText("aaaa bbbb cccc dddd\neeee ffff", 20), "aaaa bbbb cccc dddd eeee ffff");
	assert.equal(reflowText("the quick brown fox\njumps over the\nlazy dog", 20), "the quick brown fox jumps over the\nlazy dog");
	assert.equal(reflowText("one\ntwo\nthree", 20), "one\ntwo\nthree");
});

test("reflow rejoins a word cut in pieces without adding a space", () => {
	assert.equal(reflowText(`${"x".repeat(20)}\nyyyy`, 20), `${"x".repeat(20)}yyyy`);
});

test("reflow keeps paragraph breaks, tables, and indented code", () => {
	assert.equal(reflowText("aaaa bbbb cccc dddd\n\neeee", 20), "aaaa bbbb cccc dddd\n\neeee");
	assert.equal(reflowText("│ a │ b │\n│ c │ d │", 20), "│ a │ b │\n│ c │ d │");
	assert.equal(reflowText("aaaa bbbb cccc dddd\n    code here", 20), "aaaa bbbb cccc dddd\n    code here");
});

test("reflow joins list continuations and quote rows but not new items", () => {
	assert.equal(reflowText("- aaaa bbbb cccc ddd\n  eeee ffff\n- next", 20), "- aaaa bbbb cccc ddd eeee ffff\n- next");
	assert.equal(reflowText("1. aaaa bbbb cccc dd\n   eeee\n2. next", 20), "1. aaaa bbbb cccc dd eeee\n2. next");
	assert.equal(reflowText("│ aaaa bbbb cccc ddd\n│ eeee ffff", 20), "│ aaaa bbbb cccc ddd eeee ffff");
});

test("reflow strips transcript padding, accepts CRLF, and handles a selection that starts mid-row", () => {
	assert.equal(reflowText(" aaaa bbbb cccc dddd\n eeee ffff", 20, 1), "aaaa bbbb cccc dddd eeee ffff");
	assert.equal(reflowText("aaaa bbbb cccc dddd\r\neeee", 20), "aaaa bbbb cccc dddd eeee");
	assert.equal(reflowText("bbbb cccc dddd\neeee", 20, 1, 6), "bbbb cccc dddd eeee");
});

test("reflow keeps a new list item after a mid-row selection, and indented rows apart", () => {
	assert.equal(reflowText("bbbb cccc dddd eeee\n- ffff", 20, 1, 6), "bbbb cccc dddd eeee\n- ffff");
	assert.equal(reflowText("  aaaa bbbb cccc dd\n  eeee", 20), "  aaaa bbbb cccc dd\n  eeee");
});

function copyFixture() {
	const nativeCopies = [];
	const terminalWrites = [];
	const scrollView = {};
	const copyTui = {
		mode: "fullscreen",
		terminal: { write: sequence => terminalWrites.push(sequence) },
		copySelection: async text => { nativeCopies.push(text); return true; },
		getSelectionBounds: () => ({ start: { col: 0, scrollView } }),
		currentLayout: { root: { scrollView, children: [{ rect: { width: 22 } }] } },
	};
	return { copyTui, nativeCopies, terminalWrites };
}

function clipboardSequence(text) {
	// Independent wire-format expectation, including UTF-8 before base64.
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

test("chat copy: Herdr sends the reflowed selection to the viewing computer, without touching the host clipboard", async () => {
	for (const env of [{ HERDR_ENV: "1" }, { HERDR_ENV: "1", SSH_CONNECTION: "test" }]) {
		const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, env);
		const { copyTui, nativeCopies, terminalWrites } = copyFixture();
		patchCopyReflow(copyTui, () => 1);
		assert.equal(await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee ffff"), true);
		assert.deepEqual(terminalWrites, [clipboardSequence("aaaa bbbb cccc dddd eeee ffff")]);
		assert.deepEqual(nativeCopies, [], "No success from writing only the remote machine's clipboard");
	}
});

test("chat copy: outside Herdr, native copying and reflow stay unchanged", async () => {
	for (const env of [{}, { HERDR_ENV: "0" }, { SSH_CONNECTION: "test" }]) {
		const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, env);
		const { copyTui, nativeCopies, terminalWrites } = copyFixture();
		patchCopyReflow(copyTui, () => 1);
		assert.equal(await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee"), true);
		assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"]);
		assert.deepEqual(terminalWrites, []);
	}
});

test("chat copy: Unicode, paragraphs, and terminal-control characters are encoded without changes or injection", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	const { copyTui, terminalWrites } = copyFixture();
	copyTui.getSelectionBounds = () => undefined;
	patchCopyReflow(copyTui, () => 1);
	const text = "你好 😀 café\n\nsecond paragraph\n\x1b]52;c;bad\x07";
	assert.equal(await copyTui.copySelection(text), true);
	assert.deepEqual(terminalWrites, [clipboardSequence(text)]);
});

test("chat copy: unsafe selection-layout reads still copy the original text to the viewing computer", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	const { copyTui, nativeCopies, terminalWrites } = copyFixture();
	copyTui.getSelectionBounds = () => { throw new Error("layout changed"); };
	patchCopyReflow(copyTui, () => 1);
	const text = " selected\n lines";
	assert.equal(await copyTui.copySelection(text), true);
	assert.deepEqual(terminalWrites, [clipboardSequence(text)]);
	assert.deepEqual(nativeCopies, []);
});

test("chat copy: the terminal size limit is based on encoded UTF-8, and oversize copies do not report success", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	for (const [text, allowed] of [["x".repeat(75_000), true], ["x".repeat(75_001), false], ["😀".repeat(18_750), true], ["😀".repeat(18_751), false]]) {
		const { copyTui, nativeCopies, terminalWrites } = copyFixture();
		copyTui.getSelectionBounds = () => undefined;
		patchCopyReflow(copyTui, () => 1);
		const result = await copyTui.copySelection(text);
		if (allowed) {
			assert.equal(result, true);
			assert.deepEqual(terminalWrites, [clipboardSequence(text)]);
		} else {
			assert.equal(result, "Selection is too large to copy through the terminal. Copy a smaller selection.");
			assert.deepEqual(terminalWrites, []);
		}
		assert.deepEqual(nativeCopies, []);
	}
});

test("chat copy: terminal write failures do not fall back to a misleading remote-only copy", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	const { copyTui, nativeCopies } = copyFixture();
	copyTui.terminal.write = () => { throw new Error("closed terminal"); };
	patchCopyReflow(copyTui, () => 1);
	assert.equal(await copyTui.copySelection("text"), "Could not send the selection to your terminal clipboard.");
	assert.deepEqual(nativeCopies, []);
});

test("chat copy: reload replaces the wrapper rather than stacking copies", async () => {
	for (const env of [{ HERDR_ENV: "1" }, {}]) {
		const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, env);
		const { copyTui, nativeCopies, terminalWrites } = copyFixture();
		patchCopyReflow(copyTui, () => 1);
		patchCopyReflow(copyTui, () => 0);
		copyTui.getSelectionBounds = () => undefined;
		await copyTui.copySelection("one copy");
		assert.equal(nativeCopies.length + terminalWrites.length, 1);
		assert.deepEqual(env.HERDR_ENV ? terminalWrites : nativeCopies, env.HERDR_ENV ? [clipboardSequence("one copy")] : ["one copy"]);
	}
});

test("chat copy: unsupported TUI layouts are left alone", () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	const terminalWrites = [];
	const copyTui = { terminal: { write: sequence => terminalWrites.push(sequence) } };
	patchCopyReflow(copyTui, () => 1);
	assert.equal(copyTui.copySelection, undefined);
	assert.deepEqual(terminalWrites, []);
});

test("chat copy: Pi's real selection-copy action displays success only when the terminal write succeeds", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, { HERDR_ENV: "1" });
	const terminalWrites = [];
	const nativeCopies = [];
	const flashes = [];
	const terminal = { columns: 22, rows: 10, write: sequence => terminalWrites.push(sequence) };
	const liveTui = new tui.TuiAltScreen(terminal, false, undefined, {
		copySelection: async text => { nativeCopies.push(text); return true; },
	});
	// Set the last rendered transcript and selection, without starting a terminal.
	const scrollView = {};
	liveTui.currentLayout = { root: {
		scrollView,
		children: [{ rect: { width: 22 }, children: [] }],
		scrollContentLines: [" aaaa bbbb cccc dddd", " eeee ffff"],
	} };
	liveTui.selectionAnchor = { col: 0, row: 0, scrollView };
	liveTui.selectionFocus = { col: 10, row: 1, scrollView };
	liveTui.flash = message => flashes.push(message);
	patchCopyReflow(liveTui, () => 1);
	assert.equal(await liveTui.copyActiveSelectionToClipboard(), true);
	assert.deepEqual(terminalWrites, [clipboardSequence("aaaa bbbb cccc dddd eeee ffff")]);
	assert.deepEqual(flashes, ["Copied!"]);
	terminal.write = () => { throw new Error("closed terminal"); };
	assert.equal(await liveTui.copyActiveSelectionToClipboard(), false);
	assert.deepEqual(flashes, ["Copied!", "Could not send the selection to your terminal clipboard."]);
	assert.deepEqual(nativeCopies, []);
});

test("chat copy: session startup installs the local-clipboard route on the live chat selection hook", async () => {
	const { copyTui, nativeCopies, terminalWrites } = copyFixture();
	const run = await createFooter("anthropic", plainTheme, 200, { mode: "tui", copyTui, env: { HERDR_ENV: "1" } });
	try {
		assert.equal(await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee"), true);
		assert.deepEqual(terminalWrites, [clipboardSequence("aaaa bbbb cccc dddd eeee")]);
		assert.deepEqual(nativeCopies, []);
	} finally {
		await run.events.get("session_shutdown")({}, run.ctx);
	}
});

test("copy cleanup: cleanup restores the native callback exactly once", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const { copyTui, nativeCopies } = copyFixture();
	const native = copyTui.copySelection;
	const cleanup = patchCopyReflow(copyTui, () => 1);
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "Reflowed while installed");
	cleanup();
	assert.equal(copyTui.copySelection, native, "The native callback itself is back");
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies[1], " aaaa bbbb cccc dddd\n eeee", "Native copying is untouched after cleanup");
	// Repeated cleanup cannot clobber a patch installed by someone else later.
	const laterPatch = async text => native(text);
	copyTui.copySelection = laterPatch;
	cleanup();
	assert.equal(copyTui.copySelection, laterPatch, "A later callback by another extension survives");
});

test("copy cleanup: install, cleanup, and reinstall keep working", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const { copyTui, nativeCopies } = copyFixture();
	const native = copyTui.copySelection;
	const first = patchCopyReflow(copyTui, () => 1);
	first();
	patchCopyReflow(copyTui, () => 1)();
	assert.equal(copyTui.copySelection, native, "Nothing stays installed after both cleanups");
	const cleanup = patchCopyReflow(copyTui, () => 1);
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "A reinstall after cleanup reflows again");
	cleanup();
	assert.equal(copyTui.copySelection, native);
});

test("copy cleanup: an older patch's cleanup leaves a newer patch installed", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const { copyTui, nativeCopies } = copyFixture();
	const native = copyTui.copySelection;
	const older = patchCopyReflow(copyTui, () => 1);
	const newer = patchCopyReflow(copyTui, () => 1);
	older(); // A reload replaced the older patch; its cleanup must not restore yet.
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "The newer patch still reflows");
	assert.notEqual(copyTui.copySelection, native);
	newer();
	assert.equal(copyTui.copySelection, native, "The newest patch's cleanup restores native copying");
});

test("copy cleanup: another extension's replacement survives cleanup on a raw TUI", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const { copyTui, nativeCopies } = copyFixture();
	const native = copyTui.copySelection;
	const cleanup = patchCopyReflow(copyTui, () => 1);
	const applePiWrapper = copyTui.copySelection;
	const seenByOther = [];
	copyTui.copySelection = async text => { seenByOther.push(text); return applePiWrapper(text); };
	cleanup();
	assert.notEqual(copyTui.copySelection, native, "The other extension's callback stays installed");
	assert.equal(await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee"), true);
	assert.deepEqual(seenByOther, [" aaaa bbbb cccc dddd\n eeee"]);
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "Its chain through apple-pi's wrapper still works");
});

test("copy cleanup: unsupported layouts return a no-op cleanup", () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const copyTui = { terminal: { write() {} } };
	const cleanup = patchCopyReflow(copyTui, () => 1);
	assert.equal(copyTui.copySelection, undefined);
	assert.doesNotThrow(cleanup);
	assert.equal(copyTui.copySelection, undefined);
});

test("copy cleanup: Pi's real forwarding TUI reference restores native copying", async () => {
	const { patchCopyReflow } = loadExtension({}, { status: 200 }, {}, {});
	const piRoot = realpathSync(installedPackage);
	const { createInteractiveTuiReference } = await import(new URL("./dist/modes/interactive/tui-renderer.js", pathToFileURL(piRoot)));
	const { copyTui, nativeCopies } = copyFixture();
	const native = copyTui.copySelection;
	// Every function read through this reference yields a fresh closure, so
	// function identity cannot be compared through it.
	const reference = createInteractiveTuiReference(() => copyTui);
	const cleanup = patchCopyReflow(reference, () => 1);
	assert.notEqual(reference.copySelection, native);
	await reference.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "Reflow works through the reference");
	cleanup();
	assert.notEqual(copyTui.copySelection, undefined);
	// Through the reference the restored callback is a fresh forwarding closure,
	// so identity cannot be compared; its behavior must be exactly native.
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies[1], " aaaa bbbb cccc dddd\n eeee", "Native copying is restored through the reference");
	assert.equal(nativeCopies.length, 2, "No second reflowing copy happened");
});

test("copy cleanup: shutdown restores native copying, and a reload with apple-pi reinstalls one patch", async () => {
	const { copyTui, nativeCopies } = copyFixture();
	const run = await createFooter("anthropic", plainTheme, 200, { mode: "tui", copyTui, env: {} });
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies, ["aaaa bbbb cccc dddd eeee"], "Installed at session start");
	await run.events.get("session_shutdown")({}, run.ctx);
	// Removing apple-pi, then /reload without it: normal copying stays.
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies[1], " aaaa bbbb cccc dddd\n eeee", "Shutdown restored native copying");
	// A reload with apple-pi still installed reinstalls exactly one patch.
	await run.events.get("session_start")({}, run.ctx);
	await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee");
	assert.deepEqual(nativeCopies[2], "aaaa bbbb cccc dddd eeee", "One fresh patch, not a stack");
	await run.events.get("session_shutdown")({}, run.ctx);
	assert.equal(copyTui.copySelection.constructor, copyFixture().copyTui.copySelection.constructor, "Native again after the second shutdown");
});

const quotaError = "You have hit your ChatGPT usage limit (plus plan). Try again in ~22 min.";
const asPlain = value => JSON.parse(JSON.stringify(value));

async function createAutoResume(t, options = {}) {
	let time = now;
	let id = "thread-1";
	let idle = true;
	const timers = new Set();
	const clock = {
		now: () => time,
		setTimeout(fn, delay) {
			assert.ok(delay > 0 && delay <= 60_000, "Timers must be short chunks, even for weekly limits");
			const timer = { fn, due: time + delay, unref() { this.unreferenced = true; } };
			timers.add(timer);
			return timer;
		},
		clearTimeout: timer => timers.delete(timer),
	};
	const extension = loadExtension({}, { status: 200 }, clock);
	const events = new Map();
	const prompts = [];
	const messages = [];
	const statuses = new Map();
	const ctx = {
		mode: options.mode ?? "tui", hasUI: true,
		model: { provider: "openai-codex", id: "test" },
		sessionManager: { getSessionId: () => id },
		isIdle: () => idle,
		ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} },
	};
	const pi = {
		on: (event, handler) => events.set(event, handler),
		sendUserMessage: text => prompts.push(text),
		sendMessage: (message, delivery) => messages.push(asPlain({ message, delivery })),
	};
	extension.installAutoResume(pi, options.freshUsage ?? (async () => options.usage));
	const emit = (event, data = {}) => events.get(event)?.(data, ctx);
	await emit("session_start");
	t.after(() => emit("session_shutdown"));
	return {
		...extension, ctx, timers, prompts, messages, statuses, emit,
		setIdle: value => { idle = value; },
		setSessionId: value => { id = value; },
		error: (errorMessage = quotaError, stopReason = "error") => emit("message_end", { message: { role: "assistant", stopReason, errorMessage } }),
		input: (text, images) => emit("input", { text, images, source: "interactive" }),
		jump(ms) {
			time += ms;
			// Simulate sleep/wake: overdue callbacks see the actual wall clock,
			// not a reconstructed sequence of thousands of elapsed minute ticks.
			for (const timer of [...timers]) {
				if (timer.due <= time) { timers.delete(timer); timer.fn(); }
			}
		},
	};
}

test("auto-resume: retry hints accept minutes, compound durations, zero, and reject absent/invalid hints", () => {
	const { usageRetryAt, isUsageLimit } = loadExtension();
	assert.equal(usageRetryAt(quotaError, now), now + 22 * 60_000);
	assert.equal(usageRetryAt("Try again in 2 days 3 hours, 4 minutes 5 seconds.", now), now + (2 * day + 3 * hour + 4 * 60 + 5) * 1000);
	assert.equal(usageRetryAt("Try again in ~0 min.", now), now);
	assert.equal(usageRetryAt("Try again in 1.5 hours.", now), now + 90 * 60_000);
	for (const text of ["Try again later", "Try again in -1 min", "Try again in Infinity min", "Try again in 1e100 min"]) {
		assert.equal(usageRetryAt(text, now), undefined);
	}
	assert.ok(isUsageLimit("usage_limit_reached"));
	assert.ok(isUsageLimit("Subscription quota exceeded"));
	assert.equal(isUsageLimit("429: too many requests"), false);
});

test("auto-resume: always-on resumes once at the error's reset plus one minute, only after settlement", async t => {
	const run = await createAutoResume(t);
	await run.error();
	assert.equal(run.timers.size, 0, "Pi's built-in retries must settle first");
	await run.emit("agent_settled");
	await run.emit("agent_settled");
	assert.equal(run.timers.size, 1);
	assert.ok([...run.timers][0].unreferenced);
	run.jump(22 * 60_000);
	assert.deepEqual(run.prompts, []);
	run.jump(60_000);
	assert.deepEqual(run.prompts, ["continue"]);
	assert.equal(run.timers.size, 0);
	assert.equal(run.statuses.get("apple-pi-auto-resume"), undefined);
	run.jump(day * 1000);
	assert.deepEqual(run.prompts, ["continue"], "No repeated jobs after a successful submission");
});

test("auto-resume: waiting messages and images join the transcript without changing the deadline", async t => {
	const run = await createAutoResume(t);
	await run.error();
	// Input can arrive while the reset fetch is still pending, before scheduling.
	assert.deepEqual(asPlain(await run.input("Also check the tests")), { action: "handled" });
	await run.emit("agent_settled");
	run.jump(10 * 60_000);
	const image = { type: "image", data: "test-image", mimeType: "image/png" };
	await run.input("And use this screenshot", [image]);
	assert.equal(run.messages.length, 2);
	assert.deepEqual(run.messages.map(entry => entry.delivery), [{ triggerTurn: false }, { triggerTurn: false }]);
	assert.deepEqual(run.messages[1].message.content, [{ type: "text", text: "And use this screenshot" }, image]);
	assert.ok(run.messages.every(entry => entry.message.display));
	assert.ok(run.statuses.get("apple-pi-auto-resume").includes("2 queued"));
	assert.deepEqual(run.prompts, []);
	assert.equal(await run.input("/usage"), undefined, "Slash commands remain available");
	assert.deepEqual(asPlain(await run.emit("cache_warming_decision")), { action: "stop" });

	// Verify the queued transcript entries really become user content using
	// Pi's installed converter, not a mock of the provider-context contract.
	const { convertToLlm } = await import(new URL("./dist/core/messages.js", pathToFileURL(realpathSync(installedPackage))));
	const context = convertToLlm(run.messages.map(({ message }) => ({ role: "custom", timestamp: now, ...message })));
	assert.ok(context.every(message => message.role === "user"));
	assert.deepEqual(context[0].content, [{ type: "text", text: "Also check the tests" }]);
	assert.deepEqual(context[1].content, run.messages[1].message.content);
	run.jump(13 * 60_000);
	assert.deepEqual(run.prompts, ["continue"], "New input must not delay the original 23-minute deadline");
});

test("auto-resume: fresh exhausted main windows choose the later reset; unrelated buckets do not delay it", async t => {
	const run = await createAutoResume(t, { usage: { rows: [
		{ label: "5-hour", pct: 100, resetAt: now + hour * 1000 },
		{ label: "weekly", pct: 100, resetAt: now + 7 * day * 1000 },
		{ label: "reserve weekly", bucket: "reserve", pct: 100, resetAt: now + 30 * day * 1000 },
		{ label: "other", pct: 25, resetAt: now + 60 * day * 1000 },
	] } });
	await run.error();
	await run.emit("agent_settled");
	run.jump(hour * 1000 + 60_000);
	assert.deepEqual(run.prompts, []);
	run.jump(6 * day * 1000 + 23 * hour * 1000);
	assert.deepEqual(run.prompts, ["continue"]);
});

test("auto-resume: stale/invalid usage cannot override the error hint", async t => {
	for (const usage of [
		{ stale: "error 500", rows: [{ pct: 100, resetAt: now + 7 * day * 1000 }] },
		{ rows: [{ pct: 100, resetAt: Infinity }, { pct: 100, resetAt: 1e20 }] },
	]) {
		const run = await createAutoResume(t, { usage });
		await run.error();
		await run.emit("agent_settled");
		run.jump(23 * 60_000);
		assert.deepEqual(run.prompts, ["continue"]);
	}
});

test("auto-resume: unknown resets back off automatically, and known new limits can schedule again", async t => {
	const run = await createAutoResume(t, { freshUsage: async () => { throw new Error("offline"); } });
	for (const minutes of [15, 30, 60, 60]) {
		await run.error("You have hit your ChatGPT usage limit. Try again later.");
		await run.emit("agent_settled");
		const before = run.prompts.length;
		run.jump((minutes - 1) * 60_000);
		assert.equal(run.prompts.length, before);
		run.jump(60_000);
		assert.equal(run.prompts.length, before + 1);
	}
	await run.error(quotaError);
	await run.emit("agent_settled");
	run.jump(23 * 60_000);
	assert.equal(run.prompts.length, 5);
});

test("auto-resume: shutdown/reload/session replacement clear all timers and do not replay jobs", async t => {
	for (const event of ["session_shutdown", "session_start", "session_tree", "model_select"]) {
		const run = await createAutoResume(t);
		await run.error();
		await run.emit("agent_settled");
		await run.emit(event);
		assert.equal(run.timers.size, 0, event);
		run.jump(30 * day * 1000);
		assert.deepEqual(run.prompts, [], event);
	}
});

test("auto-resume: a close during an awaited reset fetch cannot revive the timer", async t => {
	let finish;
	const run = await createAutoResume(t, { freshUsage: () => new Promise(resolve => { finish = resolve; }) });
	await run.error();
	const settling = run.emit("agent_settled");
	await run.emit("session_shutdown");
	await run.emit("session_start");
	finish({ rows: [{ pct: 100, resetAt: now + 60_000 }] });
	await settling;
	assert.equal(run.timers.size, 0);
	run.jump(24 * 60_000);
	assert.deepEqual(run.prompts, []);
});

test("auto-resume: session identity is checked at delivery even if lifecycle notifications are missed", async t => {
	const run = await createAutoResume(t);
	await run.error();
	await run.emit("agent_settled");
	run.setSessionId("thread-2");
	run.jump(23 * 60_000);
	assert.equal(run.timers.size, 0);
	assert.deepEqual(run.prompts, []);
});

test("auto-resume: waits for idle and approval dialogs without losing the deadline", async t => {
	const run = await createAutoResume(t);
	await run.error();
	await run.emit("agent_settled");
	run.setIdle(false);
	run.jump(23 * 60_000);
	assert.deepEqual(run.prompts, []);
	run.setIdle(true);
	await run.emit("ui_prompt_start");
	run.jump(1000);
	assert.deepEqual(run.prompts, []);
	await run.emit("ui_prompt_end");
	run.jump(1000);
	assert.deepEqual(run.prompts, ["continue"]);
});

test("auto-resume: successful retries, other errors, and aborts cancel; ordinary input is unaffected otherwise", async t => {
	const run = await createAutoResume(t);
	assert.equal(await run.input("normal message"), undefined);
	for (const [text, reason] of [[quotaError, "stop"], [quotaError, "aborted"], ["401 authentication failed", "error"], ["429 too many requests", "error"]]) {
		await run.error();
		await run.emit("agent_settled");
		await run.error(text, reason);
		assert.equal(run.timers.size, 0);
		await run.emit("agent_settled");
	}
	assert.deepEqual(run.prompts, []);
});

test("auto-resume: the full extension wires fresh usage, queued input, footer status, and shutdown together", async t => {
	const timers = new Set();
	const clock = {
		setTimeout(fn, delay) {
			const timer = { fn, delay, unref() {} };
			timers.add(timer);
			return timer;
		},
		clearTimeout: timer => timers.delete(timer),
	};
	const run = await createFooter("openai-codex", plainTheme, 200, { mode: "rpc", clock });
	t.after(() => run.events.get("session_shutdown")({}, run.ctx));
	await run.events.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: quotaError } }, run.ctx);
	await run.events.get("agent_settled")({}, run.ctx);
	assert.equal(run.requests.length, 2, "Limit settlement forces fresh usage, without a duplicate footer request");
	assert.equal(timers.size, 1);
	assert.ok(plainText(run.footer).includes("Auto-resume at"));
	assert.deepEqual(asPlain(await run.events.get("input")({ text: "check README too", source: "interactive" }, run.ctx)), { action: "handled" });
	assert.equal(run.entries.at(-1).content, "check README too");
	assert.ok(plainText(run.footer).includes("1 queued"));
	assert.deepEqual(run.prompts, []);
	await run.events.get("session_shutdown")({}, run.ctx);
	assert.equal(timers.size, 0);
	assert.ok(!plainText(run.footer).includes("Auto-resume"));
});

test("auto-resume: a footer refresh still running at settlement is followed by a fresh fetch", async t => {
	const clock = { t: now, now: () => clock.t, setTimeout: () => ({ unref() {} }), clearTimeout() {} };
	const run = await createFooter("openai-codex", plainTheme, 200, { mode: "rpc", clock });
	t.after(() => run.events.get("session_shutdown")({}, run.ctx));
	// More than a minute after the session-start fetch, so the turn starts a footer refresh.
	clock.t += 61_000;
	await run.events.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: quotaError } }, run.ctx);
	let release;
	run.state.beforeResponse = () => new Promise(resolve => { release = resolve; });
	await run.events.get("turn_end")({}, run.ctx);
	const settled = run.events.get("agent_settled")({}, run.ctx);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.requests.length, 2, "Auto-resume waits for the pending footer fetch");
	run.state.beforeResponse = undefined;
	release();
	await settled;
	assert.equal(run.requests.length, 3, "Session start, the turn's refresh, then a fresh fetch for auto-resume");
});

test("auto-resume: only long-lived TUI and RPC sessions schedule continuations", async t => {
	for (const mode of ["print", "json", "rpc"]) {
		const run = await createAutoResume(t, { mode });
		await run.error();
		await run.emit("agent_settled");
		assert.equal(run.timers.size, mode === "rpc" ? 1 : 0, mode);
	}
});

test("guard: commands that delete files or discard work ask first", () => {
	const { destructiveReason } = loadExtension();
	for (const command of [
		"rm build.log", "rm -rf dist", "/bin/rm -f x", "sudo ls", "rmdir old", "unlink x", "truncate -s 0 log", "dd if=/dev/zero of=disk",
		"cd src && rm -rf node_modules", "npm test; rm out.txt", "echo $(rm x)", "(rm -rf x)", "if true; then rm x; fi",
		"timeout 5 rm x", "timeout 30 rm -rf build", "timeout -s TERM 30 rm -rf build", "env -S \"rm x\"", "nice -n 10 env -u FOO rm x", "nice -n 10 rm x", "env -u FOO rm x", "watch -n 5 rm x", "env -- rm x", "nice --adjustment=10 rm x",
		"FOO=1 env -i nohup rm x", "bash -c 'cd /tmp && rm -rf y'", "sh -lc \"rm x\"", "eval \"rm x\"",
		"find . -name '*.tmp' -delete", "find . \\( -name a \\) -delete", "find . -exec rm {} \;", "ls | xargs -n 1 rm",
		"rsync -a --delete src/ dst/", "mkfs.ext4 /dev/sdb1", "diskutil eraseDisk APFS X disk4",
		"git clean -fdx", "git reset --hard HEAD~1", "git checkout -- src/app.ts", "git checkout .", "git restore src/app.ts",
		"git switch -f main", "git stash drop", "git stash clear", "git branch -D feature", "git branch -d -f feature",
		"git tag -d v1", "git push --force origin main", "git push -f", "git push origin --delete old", "git push origin :old",
		"git push origin +main", "git rm src/a.ts", "git worktree remove ../wt", "git reflog expire --all", "git gc --prune=now",
		"git -C ../repo reset --hard", "git update-ref -d refs/heads/x", "git filter-branch --tree-filter x",
		"docker rm -f web", "docker system prune -a", "kubectl delete pod x", "terraform destroy", "psql -c 'DROP TABLE users'",
		"Remove-Item -Recurse build",
	]) assert.ok(destructiveReason(command), command);
});

test("guard: explanations name simple targets without guessing shell expansions", () => {
	const { destructiveReason } = loadExtension();
	assert.equal(destructiveReason("rm build.log"), "Deletes build.log.");
	assert.equal(destructiveReason("rm -rf dist"), "Deletes dist and everything inside it.");
	assert.equal(destructiveReason("git reset --hard"), "Resets your files to a saved version in Git. Changes that you have not saved can be lost.");
	assert.equal(destructiveReason("git push origin --delete old"), "Deletes the named branches or tags from the remote server. Other people can lose access to that work.");
	assert.equal(destructiveReason('rm "$OUTPUT"'), "This command can delete files or folders. You can lose their contents.");
});

test("guard: ordinary commands, read-only git, and words inside arguments run unasked", () => {
	const { destructiveReason } = loadExtension();
	for (const command of [
		"timeout 30 npm test", "nice -n 10 npm test", "env -u FOO npm test", "watch -n 2 ls",
		"ls -la", "npm test", "grep -rn rm src", "git status", "git log --oneline", "git diff", "git checkout main",
		"git checkout -b feature", "git switch main", "git restore --staged src/a.ts", "git branch -d merged", "git push",
		"git push -u origin feature", "git rm --cached secrets.env", "git clean -n", "git stash", "git commit -m 'remove the old rm helper'",
		"find . -name '*.ts'", "rsync -a src/ dst/", "docker ps", "kubectl get pods", "echo remove", "cat format.txt",
		"mv a b", "node scripts/drop-cache.js", "cmd 2>&1 | tee out.log",
	]) assert.equal(destructiveReason(command), undefined, command);
});

function guardRun({ hasUI = true, answer = "Yes", confirmError, reply, inputError, summary = "Delete the dist folder and its contents.", summaryError, stopReason = "stop", model = { id: "test-model" }, signal, clock = {}, pending = false, defer = false } = {}) {
	const extension = loadExtension({}, { status: 200 }, clock);
	const handlers = new Map();
	const signals = [];
	const asked = [];
	const summaries = [];
	// Deferred dialogs: one entry per opened select/input, closed by hand or by abort.
	const dialogs = [];
	const dialogEvents = [];
	let openDialogs = 0;
	let maxOpenDialogs = 0;
	const pi = { on: (event, handler) => handlers.set(event, handler), events: { emit: (channel, data) => signals.push([channel, data]) } };
	extension.installDestructiveGuard(pi);
	const deferredDialog = (kind, title, opts) => {
		const dialog = { kind, title, closed: false };
		let close;
		const promise = new Promise((resolve, reject) => {
			close = { resolve, reject };
		});
		const finish = settle => {
			if (dialog.closed) return;
			dialog.closed = true;
			openDialogs--;
			dialogEvents.push({ type: "close", kind });
			settle();
		};
		dialog.answer = value => finish(() => close.resolve(value));
		dialog.fail = error => finish(() => close.reject(error));
		// Real Pi selectors resolve undefined when their signal aborts.
		dialog.aborts = () => finish(() => close.resolve(undefined));
		opts?.signal?.addEventListener("abort", () => dialog.aborts(), { once: true });
		dialogs.push(dialog);
		openDialogs++;
		maxOpenDialogs = Math.max(maxOpenDialogs, openDialogs);
		dialogEvents.push({ type: "open", kind });
		return promise;
	};
	const ctxFor = callSignal => ({
		hasUI, model, signal: callSignal ?? signal,
		modelRegistry: {
			streamSimple: (selected, context, options) => {
				summaries.push({ selected, context, options });
				return { result: async () => {
					if (summaryError) throw summaryError;
					if (pending) return new Promise(() => {});
					return { stopReason, content: [{ type: "text", text: summary }] };
				} };
			},
		},
		ui: {
			input: async (title, placeholder, opts) => {
				if (defer) return deferredDialog("input", title, opts);
				assert.equal(title, "What should the agent do instead?");
				assert.equal(signals.at(-1)[1].active, true);
				if (inputError) throw inputError;
				return reply;
			},
			select: async (title, options, opts) => {
				asked.push([title, options]);
				if (defer) return deferredDialog("select", title, opts);
				// The blocked signal is active while the question is open.
				assert.deepEqual(asPlain(signals.at(-1)), ["herdr:blocked", { active: true, label: "permission: Allow this command?" }]);
				if (confirmError) throw confirmError;
				return answer === null ? undefined : answer;
			},
		},
	});
	const ctx = ctxFor();
	const call = (toolName, input, callSignal) => handlers.get("tool_call")({ toolName, input }, callSignal ? ctxFor(callSignal) : ctx);
	return { call, signals, asked, summaries, dialogs, dialogEvents, shutdown: () => handlers.get("session_shutdown")({}, ctxFor()), maxOpen: () => maxOpenDialogs, openCount: () => openDialogs, current: () => dialogs.findLast(dialog => !dialog.closed) };
}

test("guard: an allowed command runs and clears the blocked signal", async () => {
	const run = guardRun({ answer: "Yes" });
	assert.equal(await run.call("bash", { command: "rm -rf dist" }), undefined);
	assert.deepEqual(asPlain(run.asked), [["Allow this command?\n\nDelete the dist folder and its contents.\n\nCommand:\nrm -rf dist", ["Yes", "No", "Type a reply"]]]);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard: summarises the whole command with the current model and no tools", async () => {
	const command = "cd app && rm -rf dist && npm run build";
	const summary = "Go to app, delete dist, then build the app if each earlier step succeeds.";
	const run = guardRun({ summary });
	await run.call("bash", { command });
	assert.equal(run.asked[0][0], `Allow this command?\n\n${summary}\n\nCommand:\n${command}`);
	assert.equal(run.summaries.length, 1);
	const request = run.summaries[0];
	assert.equal(request.selected.id, "test-model");
	assert.deepEqual(asPlain(JSON.parse(request.context.messages[0].content)), { shell: "bash", command });
	assert.equal(request.context.messages.length, 1);
	assert.equal(request.context.tools, undefined);
	assert.match(request.context.systemPrompt, /entire command/);
	assert.match(request.context.systemPrompt, /untrusted data/);
	assert.ok(request.options.maxTokens <= 1024);
});

test("guard: failed or incomplete summaries do not become approval or a misleading fallback", async () => {
	for (const options of [
		{ summaryError: new Error("offline") }, { summary: "" }, { stopReason: "length" },
		{ stopReason: "error" }, { stopReason: "toolUse" }, { summary: "x".repeat(2401) },
		{ summary: "\u001b[2Jhidden" }, { model: null },
	]) {
		const run = guardRun({ ...options, answer: "No" });
		assert.equal((await run.call("bash", { command: "rm x" })).block, true);
		assert.equal(run.asked[0][0], "Allow this command?\n\nSummary unavailable. Read the full command before you decide.\n\nCommand:\nrm x");
	}
});

test("guard: a summary timeout aborts the request even when the provider never returns", async () => {
	let expire;
	let cleared = false;
	const run = guardRun({ pending: true, answer: "No", clock: {
		setTimeout: (fn, ms) => { assert.equal(ms, 15000); expire = fn; return 123; },
		clearTimeout: id => { assert.equal(id, 123); cleared = true; },
	} });
	const call = run.call("bash", { command: "rm x" });
	expire();
	assert.equal((await call).block, true);
	assert.equal(run.summaries[0].options.signal.aborted, true);
	assert.equal(cleared, true);
	assert.match(run.asked[0][0], /Summary unavailable/);
});

test("guard: cancelling during a summary stops the command without opening a question", async () => {
	const controller = new AbortController();
	const run = guardRun({ pending: true, signal: controller.signal });
	const call = run.call("bash", { command: "rm x" });
	controller.abort();
	assert.equal((await call).block, true);
	assert.equal(run.asked.length, 0);
	assert.equal(run.signals.at(-1)[1].active, false);
});

test("guard: long commands are not sent as misleading partial summaries", async () => {
	const run = guardRun({ answer: "No" });
	const command = "rm " + "x".repeat(16000);
	assert.equal((await run.call("bash", { command })).block, true);
	assert.equal(run.summaries.length, 0);
	assert.ok(run.asked[0][0].endsWith(command));
});

test("guard: a failed question clears the blocked signal without allowing the command", async () => {
	const run = guardRun({ confirmError: new Error("dialog closed") });
	await assert.rejects(run.call("bash", { command: "rm x" }), /dialog closed/);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard: a typed reply stops the command and reaches the agent", async () => {
	const run = guardRun({ answer: "Type a reply", reply: "Keep dist. Delete only the log." });
	const result = await run.call("bash", { command: "rm -rf dist" });
	assert.equal(result.block, true);
	assert.match(result.reason, /User reply:\nKeep dist\. Delete only the log\./);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard: a failed reply clears the blocked signal", async () => {
	const run = guardRun({ answer: "Type a reply", inputError: new Error("input closed") });
	await assert.rejects(run.call("bash", { command: "rm x" }), /input closed/);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard: cancelled selections and empty replies never allow the command", async () => {
	for (const options of [{ answer: null }, { answer: "Type a reply" }, { answer: "Type a reply", reply: "   " }]) {
		const run = guardRun(options);
		assert.equal((await run.call("bash", { command: "rm x" })).block, true);
	}
});

test("guard: a declined command is blocked and tells the model to ask the user", async () => {
	const run = guardRun({ answer: "No" });
	const result = await run.call("bash", { command: "git reset --hard" });
	assert.equal(result.block, true);
	assert.match(result.reason, /Command stopped\. Resets your files to a saved version in Git\..*Ask the user/);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard: print and JSON runs block without asking; safe and non-shell calls pass untouched", async () => {
	const headless = guardRun({ hasUI: false });
	assert.equal((await headless.call("bash", { command: "rm x" })).block, true);
	assert.equal(headless.asked.length + headless.signals.length + headless.summaries.length, 0);
	const run = guardRun();
	assert.equal(await run.call("bash", { command: "npm test" }), undefined);
	assert.equal(await run.call("write", { path: "rm", content: "rm -rf /" }), undefined);
	assert.equal(run.summaries.length, 0);
	assert.equal((await run.call("powershell", { command: "Remove-Item x" })), undefined);
	assert.equal(run.asked.length, 1);
});

// The queue tests drive deferred dialogs by hand, the way codemode's concurrent
// nested calls arrive: several flagged commands enter the handler together.
// `current()` is the one open dialog; `settle()` lets the queue advance.
const settle = () => new Promise(resolve => setImmediate(resolve));

test("guard queue: two concurrent commands ask one at a time and both settle", async () => {
	const run = guardRun({ defer: true });
	const first = run.call("bash", { command: "rm -rf dist" });
	const second = run.call("bash", { command: "rm -rf build" });
	await settle();
	assert.equal(run.dialogs.length, 1, "Only the first command opens a question");
	assert.ok(run.dialogs[0].title.includes("rm -rf dist"));
	run.dialogs[0].answer("Yes");
	assert.equal(await first, undefined, "The first command is allowed");
	await settle();
	assert.equal(run.dialogs.length, 2, "The second question opens only after the first settles");
	assert.ok(run.current().title.includes("rm -rf build"));
	run.current().answer("No");
	assert.equal((await second).block, true, "The second command is declined after its own question");
	assert.equal(run.maxOpen(), 1, "At most one dialog is ever open");
	assert.deepEqual(run.dialogEvents, [
		{ type: "open", kind: "select" }, { type: "close", kind: "select" },
		{ type: "open", kind: "select" }, { type: "close", kind: "select" },
	]);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
});

test("guard queue: three commands survive a failed question in the middle", async () => {
	const run = guardRun({ defer: true });
	const first = run.call("bash", { command: "rm a" });
	const second = run.call("bash", { command: "rm b" });
	const third = run.call("bash", { command: "rm c" });
	await settle();
	run.current().answer("Yes");
	assert.equal(await first, undefined);
	await settle();
	run.current().fail(new Error("dialog closed"));
	await assert.rejects(second, /dialog closed/);
	await settle();
	assert.ok(run.current().title.includes("rm c"), "The queue keeps going after a failed question");
	run.current().answer("Yes");
	assert.equal(await third, undefined);
	assert.equal(run.maxOpen(), 1);
});

test("guard queue: cancelling while waiting blocks the command without opening a question", async () => {
	const run = guardRun({ defer: true });
	const firstController = new AbortController();
	const secondController = new AbortController();
	const first = run.call("bash", { command: "rm a" }, firstController.signal);
	const second = run.call("bash", { command: "rm b" }, secondController.signal);
	await settle();
	assert.equal(run.dialogs.length, 1);
	// The queued call is cancelled while the first question is still open.
	secondController.abort();
	assert.equal((await second).block, true, "The queued call settles blocked, before the open question does");
	assert.equal(run.dialogs.length, 1, "No question opened for the cancelled call");
	assert.equal(run.maxOpen(), 1);
	// The cancelled call must not clear the first question's Herdr status.
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: true, label: "permission: Allow this command?" }]);
	// A run that arrives already cancelled never queues either.
	const lateController = new AbortController();
	lateController.abort();
	assert.equal((await run.call("bash", { command: "rm b" }, lateController.signal)).block, true);
	run.current().answer("No");
	assert.equal((await first).block, true);
	assert.equal(run.dialogs.length, 1, "Still only one question was ever opened");
});

test("guard queue: cancelling during a dialog blocks that command", async () => {
	const run = guardRun({ defer: true });
	const controller = new AbortController();
	const call = run.call("bash", { command: "rm a" }, controller.signal);
	await settle();
	controller.abort(); // The open dialog resolves undefined, as Pi's selectors do.
	assert.equal((await call).block, true, "A cancelled question never allows the command");
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
	assert.equal(run.dialogs.length, 1);
});

test("guard queue: a typed reply holds the queue until it is submitted", async () => {
	const run = guardRun({ defer: true });
	const first = run.call("bash", { command: "rm a" });
	const second = run.call("bash", { command: "rm b" });
	await settle();
	run.current().answer("Type a reply");
	await settle();
	assert.equal(run.current().kind, "input", "The reply dialog opens");
	assert.equal(run.maxOpen(), 1, "The reply dialog replaces the question, still one at a time");
	// The second command cannot open its question while the reply is pending.
	await settle();
	assert.equal(run.dialogs.length, 2);
	run.current().answer("Keep a. Delete only b.");
	const result = await first;
	assert.equal(result.block, true);
	assert.match(result.reason, /User reply:\nKeep a\. Delete only b\./);
	await settle();
	assert.ok(run.current().title.includes("rm b"), "The second question opens after the reply");
	run.current().answer("No");
	assert.equal((await second).block, true);
	assert.equal(run.maxOpen(), 1);
});

test("guard queue: shutdown blocks waiting calls, frees the queue, and blocks stale ones", async () => {
	const run = guardRun({ defer: true });
	const first = run.call("bash", { command: "rm a" });
	const second = run.call("bash", { command: "rm b" });
	await settle();
	run.shutdown();
	// Every in-flight interaction settles blocked; none of them runs a command.
	assert.equal((await first).block, true);
	assert.equal((await second).block, true);
	assert.deepEqual(asPlain(run.signals.at(-1)), ["herdr:blocked", { active: false }]);
	assert.equal(run.dialogs.length, 1, "The queued question never opened");
	// The shut-down session's dialog resolves the way a destroyed UI does.
	run.dialogs[0].aborts();
	// The replacement session can ask again; an old queued request cannot.
	const third = run.call("bash", { command: "rm c" });
	await settle();
	assert.ok(run.current().title.includes("rm c"), "The replacement session's question opens");
	run.current().answer("No");
	assert.equal((await third).block, true);
	assert.equal(run.maxOpen(), 1);
});

test("guard queue: Pi's real extension selector resolves only one dialog at a time", async t => {
	// Documents why the queue exists: InteractiveMode has a single editor slot,
	// so a second selector opened on top of the first displaces it without
	// resolving its promise. Uses Pi's real selector with a fake editor; no real
	// session is started and no command runs.
	const piRoot = realpathSync(installedPackage);
	const { initTheme } = await import(new URL("./dist/modes/interactive/theme/theme.js", pathToFileURL(piRoot)));
	initTheme("system");
	const { InteractiveMode } = await import(new URL("./dist/modes/interactive/interactive-mode.js", pathToFileURL(piRoot)));
	const blocked = [];
	const added = [];
	const mode = {
		extensionSelector: undefined,
		activeSelectorDispose: undefined,
		activeSelectorToken: undefined,
		disposeActiveSelector: InteractiveMode.prototype.disposeActiveSelector,
		editorContainer: { clear() { added.length = 0; }, addChild(component) { added.push(component); } },
		ui: { setFocus() {}, requestRender() {} },
		programStatus: { setBlocked: (key, value) => blocked.push([key, value]) },
	};
	const select = InteractiveMode.prototype.showExtensionSelector.bind(mode);
	const first = select("Allow this command?\n\nfirst", ["Yes", "No"]);
	await settle();
	t.assert.equal(added.length, 1);
	const second = select("Allow this command?\n\nsecond", ["Yes", "No"]);
	await settle();
	// The displaced selector's promise never settles: this is the hang the queue
	// prevents by never opening a second question.
	let firstSettled = false;
	void first.then(() => { firstSettled = true; });
	await settle();
	t.assert.equal(firstSettled, false);
	t.assert.equal(blocked.at(-1)[1].message, "Allow this command?\n\nsecond");
});
