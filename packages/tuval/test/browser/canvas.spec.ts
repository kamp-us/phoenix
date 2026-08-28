import {type ChildProcess, spawn} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, type Page, test} from "@playwright/test";
import type {DiscoveredSession, DiscoveryOutcome} from "../../src/shared/discovery.js";

let processRoot = "";
let tuval: ChildProcess | undefined;
let tuvalUrl = "";

const session = (id: string, cwd: string): DiscoveredSession => ({
	identity: `pi:${id}` as DiscoveredSession["identity"],
	piSessionId: id,
	createdAt: Date.parse("2026-08-27T12:00:00.000Z"),
	updatedAt: Date.parse("2026-08-27T12:04:00.000Z"),
	cwd,
	sourceFile: `/controlled/${id}.jsonl`,
});

const writeSession = async (directory: string, id: string, cwd: string): Promise<void> => {
	await writeFile(
		join(directory, `2026-08-27T12-00-00-000Z_${id}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-08-27T12:00:00.000Z",
			cwd,
		})}\n`,
	);
};

const startProcess = async (sessionRoot: string): Promise<{child: ChildProcess; url: string}> => {
	const bin = fileURLToPath(new URL("../../dist/backend/bin.js", import.meta.url));
	const child = spawn(process.execPath, [bin, "--no-open"], {
		env: {...process.env, PI_CODING_AGENT_SESSION_DIR: sessionRoot},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = await new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("tuval did not report readiness within 10 seconds")),
			10_000,
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			const match = /Tuval ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolve(match[1]);
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`tuval exited before readiness (${code}): ${stderr}`));
		});
	});
	return {child, url};
};

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
	if (child === undefined || child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

const fateEnvelope = (outcome: DiscoveryOutcome): unknown => ({
	version: 1,
	results: [{id: "discovery", ok: true, data: outcome}],
});

const routeOutcome = async (
	page: Page,
	outcome: () => DiscoveryOutcome,
	delay = 0,
): Promise<void> => {
	await page.route("**/fate", async (route) => {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(fateEnvelope(outcome())),
		});
	});
};

const pageErrors = (page: Page): Array<string> => {
	const errors: Array<string> = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
};

test.beforeAll(async () => {
	processRoot = await mkdtemp(join(tmpdir(), "tuval-playwright-"));
	const project = join(processRoot, "--Users-test-canvas");
	await mkdir(project);
	await writeSession(project, "session-alpha", "/Users/test/alpha");
	await writeSession(project, "session-beta", "/Users/test/beta");
	const started = await startProcess(processRoot);
	tuval = started.child;
	tuvalUrl = started.url;
});

test.afterAll(async () => {
	await stopProcess(tuval);
	if (processRoot.length > 0) await rm(processRoot, {recursive: true, force: true});
});

test("the existing tuval process renders a free-pan keyboard and pointer canvas", async ({
	page,
}) => {
	const errors = pageErrors(page);
	await page.goto(tuvalUrl);
	const nodes = page.locator(".session-node");
	await expect(nodes).toHaveCount(2);
	await expect(page.locator("#status-label")).toHaveText("Connected");
	await expect(page.locator("aside")).toHaveCount(0);

	const canvas = page.locator("#canvas");
	const stage = page.locator("#canvas-stage");
	await canvas.focus();
	const beforeKeyboardPan = await stage.getAttribute("style");
	await page.keyboard.press("ArrowRight");
	await expect(stage).not.toHaveAttribute("style", beforeKeyboardPan ?? "");

	await canvas.hover();
	await page.mouse.wheel(0, -100);
	await expect(page.locator("#zoom-output")).not.toHaveText("100%");

	const bounds = await canvas.boundingBox();
	expect(bounds).not.toBeNull();
	if (bounds !== null) {
		const beforePointerPan = await stage.getAttribute("style");
		await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.45);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * 0.8 + 48, bounds.y + bounds.height * 0.45 + 32);
		await page.mouse.up();
		await expect(stage).not.toHaveAttribute("style", beforePointerPan ?? "");
	}

	await nodes.first().click();
	await expect(nodes.first()).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("#selection")).toBeVisible();
	await nodes.first().focus();
	await page.keyboard.press("ArrowRight");
	await expect(nodes.nth(1)).toBeFocused();
	expect(errors).toEqual([]);
});

test("stable identity updates reuse nodes and never duplicate them", async ({page}) => {
	const errors = pageErrors(page);
	const alpha = session("stable-alpha", "/work/alpha");
	const beta = session("stable-beta", "/work/beta");
	const gamma = session("stable-gamma", "/work/gamma");
	let outcome: DiscoveryOutcome = {_tag: "ready", sessions: [alpha, alpha, beta]};
	await routeOutcome(page, () => outcome);
	await page.goto(tuvalUrl);
	await expect(page.locator(".session-node")).toHaveCount(2);
	const alphaNode = page.locator('[data-session-identity="pi:stable-alpha"]');
	const position = await alphaNode.getAttribute("style");
	await page.evaluate(() => {
		Reflect.set(
			window,
			"__tuvalStableNode",
			document.querySelector('[data-session-identity="pi:stable-alpha"]'),
		);
	});

	outcome = {
		_tag: "ready",
		sessions: [{...alpha, cwd: "/work/alpha-renamed"}, gamma],
	};
	await page.locator("#refresh-sessions").click();
	await expect(page.locator('[data-session-identity="pi:stable-gamma"]')).toBeVisible();
	await expect(page.locator('[data-session-identity="pi:stable-beta"]')).toHaveCount(0);
	await expect(page.locator(".session-node")).toHaveCount(2);
	expect(await alphaNode.getAttribute("style")).toBe(position);
	expect(
		await page.evaluate(
			() =>
				Reflect.get(window, "__tuvalStableNode") ===
				document.querySelector('[data-session-identity="pi:stable-alpha"]'),
		),
	).toBe(true);
	expect(errors).toEqual([]);
});

test("loading is explicit while discovery is in flight", async ({page}) => {
	const errors = pageErrors(page);
	await routeOutcome(page, () => ({_tag: "empty", sessions: []}), 300);
	await page.goto(tuvalUrl);
	await expect(page.locator("#status-label")).toHaveText("Discovering");
	await expect(page.locator("#state-title")).toHaveText("Finding active work");
	await expect(page.locator("#status-label")).toHaveText("No sessions");
	expect(errors).toEqual([]);
});

const stateCases: ReadonlyArray<{
	readonly name: string;
	readonly outcome: DiscoveryOutcome;
	readonly status: string;
	readonly title: string;
	readonly action: string;
	readonly nodes: number;
}> = [
	{
		name: "empty",
		outcome: {_tag: "empty", sessions: []},
		status: "No sessions",
		title: "No sessions found",
		action: "Scan again",
		nodes: 0,
	},
	{
		name: "partial source",
		outcome: {
			_tag: "partial-source",
			sessions: [session("readable", "/work/readable")],
			problems: [{source: "/fixtures/broken.jsonl", message: "header is not valid JSON"}],
		},
		status: "Partial source",
		title: "A source could not be read",
		action: "Retry discovery",
		nodes: 1,
	},
	{
		name: "disconnected transport",
		outcome: {_tag: "transport", message: "synthetic connection loss", retryable: true},
		status: "Disconnected",
		title: "Tuval cannot reach pi",
		action: "Reconnect",
		nodes: 0,
	},
	{
		name: "fatal startup",
		outcome: {
			_tag: "fatal",
			message: "Tuval could not read any configured pi session source",
			problems: [{source: "/fixtures/sessions", message: "permission denied"}],
		},
		status: "Startup blocked",
		title: "Check the session source",
		action: "Try startup again",
		nodes: 0,
	},
];

for (const stateCase of stateCases) {
	test(`${stateCase.name} has a distinct non-color-only action state`, async ({page}) => {
		const errors = pageErrors(page);
		await routeOutcome(page, () => stateCase.outcome);
		await page.goto(tuvalUrl);
		await expect(page.locator("#status-label")).toHaveText(stateCase.status);
		await expect(page.locator("#state-title")).toHaveText(stateCase.title);
		await expect(page.locator("#state-action")).toHaveText(stateCase.action);
		await expect(page.locator(".session-node")).toHaveCount(stateCase.nodes);
		await expect(page.locator("#discovery-status")).toHaveAttribute("data-tone", /.+/);
		expect(errors).toEqual([]);
	});
}
