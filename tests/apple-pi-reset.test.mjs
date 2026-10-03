// Run from the repository root: pnpm test
// Uses Pi's installed compiler and TUI helpers. Auth and HTTP are mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const globalModules = execFileSync("pnpm", ["root", "-g"], { encoding: "utf8" }).trim();
const packagePath = "@earendil-works/pi-coding-agent/package.json";
const installedPackage = [join(globalModules, packagePath), ...readdirSync(globalModules).map(dir => join(globalModules, dir, "node_modules", packagePath))].find(existsSync);
assert.ok(installedPackage, "Pi must be installed through pnpm");
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

function loadExtension(responses = {}) {
	const exports = {};
	const requests = [];
	const builtin = () => ({ renderCall() {} });
	const piModule = {
		getAgentDir: () => "/mock-agent",
		UserMessageComponent: class {},
		...Object.fromEntries(["Bash", "Edit", "Find", "Grep", "Ls", "PowerShell", "Read", "Write"].map(name => [`create${name}ToolDefinition`, builtin])),
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
					anthropic: { type: "oauth", access: "test" },
					"openai-codex": { type: "oauth", access: "test", accountId: "test" },
				}),
			};
			if (name === "node:path") return requirePi(name);
			throw new Error(`Unexpected import: ${name}`);
		},
		Date: class extends Date { static now() { return now; } },
		Intl, Buffer, AbortSignal, setImmediate,
		process: { env: {} },
		fetch: async url => {
			requests.push(url);
			assert.ok(Object.hasOwn(responses, url), `Unexpected HTTP request: ${url}`);
			return { ok: true, json: async () => responses[url] };
		},
	});
	assert.equal(exports.__JITI_ERROR__, undefined, "The extension must compile");
	return { ...exports, requests };
}

const { formatReset } = loadExtension();
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
	anthropic: {
		url: "https://api.anthropic.com/api/oauth/usage",
		response: {
			five_hour: { utilization: 25, resets_at: new Date(resetAt).toISOString() },
			seven_day: { utilization: 40, resets_at: new Date(resetAt).toISOString() },
		},
		stamps: ["18:30", "Sun 6 Oct, 18:30"],
	},
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

async function createFooter(provider, theme) {
	const fixture = fixtures[provider];
	const extension = loadExtension({ [fixture.url]: fixture.response });
	const events = new Map();
	let footer;
	extension.default({
		on: (name, handler) => events.set(name, handler),
		registerTool() {}, registerCommand() {}, registerMarkdownTransformer() {},
	});
	const ctx = {
		mode: "print", cwd: "/mock", hasUI: false,
		model: { id: "test", provider },
		sessionManager: { getEntries: () => [], getCwd: () => "/mock" },
		ui: {
			setWidget() {},
			setFooter(factory) {
				footer = factory({ requestRender() {} }, theme, {
					getGitBranch: () => undefined,
					getAvailableProviderCount: () => 1,
					getExtensionStatuses: () => new Map(),
				});
			},
		},
	};
	await events.get("session_start")({}, ctx);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(extension.requests.length, 1);
	return { footer, fixture, events, ctx, requests: extension.requests };
}

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
}
