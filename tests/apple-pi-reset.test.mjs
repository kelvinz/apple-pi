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
// Set to make the mocked SettingsManager fail, as a locked settings file would.
const settingsFailure = { on: false };

// `state.status` is the HTTP status every mocked request returns; tests change it mid-run.
function loadExtension(responses = {}, state = { status: 200 }, clock = {}, env = {}) {
	const exports = {};
	const requests = [];
	const toolCalls = {};
	const settingsCalls = [];
	const piModule = {
		getAgentDir: () => "/mock-agent",
		UserMessageComponent: class {},
		SettingsManager: {
			create: (cwd, agentDir, options) => {
				settingsCalls.push({ cwd, agentDir, options });
				if (settingsFailure.on) throw new Error("ELOCKED");
				return { getImageAutoResize: () => false, getShellCommandPrefix: () => "set -e", getShellPath: () => "/bin/zsh" };
			},
		},
		...Object.fromEntries(["Bash", "Edit", "Find", "Grep", "Ls", "PowerShell", "Read", "Write"].map(name => [
			`create${name}ToolDefinition`,
			(cwd, options) => {
				toolCalls[name.toLowerCase()] = { cwd, options };
				return { renderCall() {} };
			},
		])),
	};
	runInNewContext(compiled, {
		exports,
		module: { exports },
		require(name) {
			if (name === "@earendil-works/pi-coding-agent") return piModule;
			if (name === "@earendil-works/pi-tui") return tui;
			if (name === "node:fs") return {
				readFileSync: () => JSON.stringify({
					zai: { type: "api_key", key: "test" },
					"openai-codex": { type: "oauth", access: "test", accountId: "test" },
				}),
			};
			if (name === "node:path") return requirePi(name);
			throw new Error(`Unexpected import: ${name}`);
		},
		Date: class extends Date { static now() { return clock.now?.() ?? now; } },
		Intl, Buffer, AbortSignal, setImmediate,
		setTimeout: clock.setTimeout ?? setTimeout,
		clearTimeout: clock.clearTimeout ?? clearTimeout,
		process: { env },
		fetch: async url => {
			requests.push(url);
			assert.ok(Object.hasOwn(responses, url), `Unexpected HTTP request: ${url}`);
			return { ok: state.status >= 200 && state.status < 300, status: state.status, json: async () => responses[url] };
		},
	});
	assert.equal(exports.__JITI_ERROR__, undefined, "The extension must compile");
	return { ...exports, requests, toolCalls, settingsCalls };
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

async function createFooter(provider, theme, status = 200, projectTrusted = true, options = {}) {
	// Providers without a fixture have no usage endpoint, so nothing is requested.
	const fixture = fixtures[provider];
	const state = { status };
	const extension = loadExtension(fixture ? { [fixture.url]: fixture.response } : {}, state, options.clock, options.env);
	const events = new Map();
	const commands = new Map();
	const tools = [];
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
		registerCommand: (name, command) => commands.set(name, command),
		registerMarkdownTransformer() {},
		sendUserMessage: text => prompts.push(text),
		sendMessage: message => entries.push({ type: "custom_message", ...asPlain(message) }),
	});
	const notices = [];
	const ctx = {
		mode: options.mode ?? "print", cwd: "/mock", hasUI: true, isProjectTrusted: () => projectTrusted, isIdle: () => true,
		model: { id: "test", provider },
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
	assert.equal(extension.requests.length, fixture ? 1 : 0);
	return { footer, fixture, events, commands, ctx, entries, state, tools, notices, prompts, toolCalls: extension.toolCalls, settingsCalls: extension.settingsCalls, requests: extension.requests };
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

test("providers without a usage endpoint make no request", async () => {
	for (const provider of ["anthropic", "zai-coding-cn"]) {
		const { footer, requests } = await createFooter(provider, plainTheme);
		assert.ok(plainText(footer).includes("no usage endpoint"), provider);
		assert.equal(requests.length, 0);
	}
});

test("built-in tools are re-registered with the user's Pi settings", async () => {
	const { tools, toolCalls: realmCalls } = await createFooter("zai", plainTheme);
	const toolCalls = JSON.parse(JSON.stringify(realmCalls)); // the mock runs in another vm realm
	assert.equal(tools.length, 8);
	assert.deepEqual(toolCalls.bash, { cwd: "/mock", options: { commandPrefix: "set -e", shellPath: "/bin/zsh" } });
	assert.deepEqual(toolCalls.read, { cwd: "/mock", options: { autoResizeImages: false } });
	assert.deepEqual(toolCalls.edit, { cwd: "/mock" });
});

test("project settings reach the built-in tools only when Pi trusts the project", async () => {
	for (const trusted of [true, false]) {
		const { settingsCalls } = await createFooter("zai", plainTheme, 200, trusted);
		assert.deepEqual(JSON.parse(JSON.stringify(settingsCalls)), [{ cwd: "/mock", agentDir: "/mock-agent", options: { projectTrusted: trusted } }]);
	}
});

test("a settings read failure warns and still registers the tools without settings", async () => {
	settingsFailure.on = true;
	try {
		const { notices, tools, toolCalls: realmCalls } = await createFooter("zai", plainTheme);
		assert.deepEqual(notices, [["apple-pi registration unavailable", "warning"]]);
		assert.equal(tools.length, 8);
		assert.deepEqual(JSON.parse(JSON.stringify(realmCalls)).bash, { cwd: "/mock" });
	} finally {
		settingsFailure.on = false;
	}
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
	const run = await createFooter("anthropic", plainTheme, 200, true, { mode: "tui", copyTui, env: { HERDR_ENV: "1" } });
	try {
		assert.equal(await copyTui.copySelection(" aaaa bbbb cccc dddd\n eeee"), true);
		assert.deepEqual(terminalWrites, [clipboardSequence("aaaa bbbb cccc dddd eeee")]);
		assert.deepEqual(nativeCopies, []);
	} finally {
		await run.events.get("session_shutdown")({}, run.ctx);
	}
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
	const run = await createFooter("openai-codex", plainTheme, 200, true, { mode: "rpc", clock });
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

test("auto-resume: only long-lived TUI and RPC sessions schedule continuations", async t => {
	for (const mode of ["print", "json", "rpc"]) {
		const run = await createAutoResume(t, { mode });
		await run.error();
		await run.emit("agent_settled");
		assert.equal(run.timers.size, mode === "rpc" ? 1 : 0, mode);
	}
});
