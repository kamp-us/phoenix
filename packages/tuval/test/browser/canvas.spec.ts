import {type ChildProcess, spawn} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, type Page, type Route, test} from "@playwright/test";
import type {DiscoveredSession, DiscoveryOutcome} from "../../src/shared/discovery.js";
import type {AttachedLiveSession} from "../../src/shared/live-session.js";

let processRoot = "";
let tuval: ChildProcess | undefined;
let tuvalUrl = "";

const session = (id: string, cwd: string, parentSessionId?: string): DiscoveredSession => ({
	identity: `pi:${id}` as DiscoveredSession["identity"],
	piSessionId: id,
	createdAt: Date.parse("2026-08-27T12:00:00.000Z"),
	updatedAt: Date.parse("2026-08-27T12:04:00.000Z"),
	cwd,
	sourceFile: `/controlled/${id}.jsonl`,
	...(parentSessionId === undefined ? {} : {parentSessionId}),
});

const liveSession = (
	id: string,
	revision = 1,
	transcript: AttachedLiveSession["transcript"] = [
		{
			id: `${id}-existing`,
			role: "assistant",
			content: [{type: "text", text: `${id} mevcut konuşma`}],
			timestamp: 1,
			status: "complete",
		},
	],
): AttachedLiveSession => ({
	_tag: "attached",
	sessionId: id,
	revision,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "idle",
	transcript,
	lastEventSequence: 4,
	connection: "connected",
	ownership: "exclusive",
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

const fateEnvelope = (id: string, data: unknown): unknown => ({
	version: 1,
	results: [{id, ok: true, data}],
});

const fulfill = (route: Route, id: string, data: unknown) =>
	route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(fateEnvelope(id, data)),
	});

const routeOutcome = async (
	page: Page,
	outcome: () => DiscoveryOutcome,
	delay = 0,
): Promise<void> => {
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			await fulfill(route, id, outcome());
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId?: unknown} | undefined;
			const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "unknown";
			await fulfill(route, id, {
				_tag: "refused",
				sessionId,
				code: "disconnected",
				reason: "test live transport is unavailable",
			});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
};

const installEventSource = async (page: Page): Promise<void> => {
	await page.addInitScript(() => {
		class TestEventSource {
			static readonly instances: Array<TestEventSource> = [];
			readonly url: string;
			onopen: ((event: Event) => unknown) | null = null;
			onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
			onerror: ((event: Event) => unknown) | null = null;

			constructor(url: string | URL) {
				this.url = String(url);
				TestEventSource.instances.push(this);
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}

			close(): void {}
		}
		Reflect.set(window, "EventSource", TestEventSource);
		Reflect.set(window, "__tuvalEmit", (data: string) => {
			TestEventSource.instances.at(-1)?.onmessage?.(new MessageEvent("message", {data}));
		});
		Reflect.set(window, "__tuvalDisconnect", () => {
			TestEventSource.instances.at(-1)?.onerror?.(new Event("error"));
		});
	});
};

const emitLive = async (page: Page, event: unknown): Promise<void> => {
	await page.evaluate((data) => {
		const emit = Reflect.get(window, "__tuvalEmit") as ((value: string) => void) | undefined;
		emit?.(typeof data === "string" ? data : JSON.stringify(data));
	}, event);
};

const disconnectLive = async (page: Page): Promise<void> => {
	await page.evaluate(() => {
		const disconnect = Reflect.get(window, "__tuvalDisconnect") as (() => void) | undefined;
		disconnect?.();
	});
};

const selectNode = async (page: Page, identity: string): Promise<void> => {
	await page.locator(`[data-id="${identity}"]`).evaluate((node) => {
		if (!(node instanceof HTMLElement)) throw new Error("session node is not focusable");
		node.focus();
		node.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", bubbles: true}));
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

test("the existing tuval process renders the React Flow pan and zoom canvas", async ({page}) => {
	const errors = pageErrors(page);
	await page.goto(tuvalUrl);
	const nodes = page.locator(".react-flow__node");
	await expect(nodes).toHaveCount(2);
	await expect(page.locator("#status-label")).toHaveText("Bağlı");
	await expect(page.locator("aside")).toHaveCount(0);

	const pane = page.locator(".react-flow__pane");
	const viewport = page.locator(".react-flow__viewport");
	const beforePan = await viewport.getAttribute("style");
	const bounds = await pane.boundingBox();
	expect(bounds).not.toBeNull();
	if (bounds !== null) {
		await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.7);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * 0.75 + 64, bounds.y + bounds.height * 0.7 + 40);
		await page.mouse.up();
	}
	await expect(viewport).not.toHaveAttribute("style", beforePan ?? "");

	const beforeZoom = await viewport.getAttribute("style");
	await page.getByRole("button", {name: "Uzaklaştır"}).click();
	await expect(viewport).not.toHaveAttribute("style", beforeZoom ?? "");

	await nodes.first().focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.getByRole("alert")).toContainText("Bağlantı kesildi");
	expect(errors).toEqual([]);
});

test("React Flow renders and operates the complete keyboard relationship contract", async ({
	page,
}) => {
	const errors = pageErrors(page);
	const root = session("flow-root", "/work/root");
	const child = session("flow-child", "/work/child", "flow-root");
	await routeOutcome(page, () => ({_tag: "ready", sessions: [root, child]}));
	await page.goto(tuvalUrl);

	const rootNode = page.locator('[data-id="pi:flow-root"]');
	const childNode = page.locator('[data-id="pi:flow-child"]');
	const edge = page.locator('[data-id="relationship:pi:flow-root:pi:flow-child"]');
	await expect(rootNode).toHaveAttribute("aria-label", "root oturumu, flow-root");
	await expect(childNode).toHaveAttribute("aria-label", "child oturumu, flow-child");
	await expect(edge).toHaveAttribute(
		"aria-label",
		"flow-root oturumundan flow-child oturumuna ilişki",
	);
	await expect(rootNode).toHaveAttribute("tabindex", "0");
	await expect(edge).toHaveAttribute("tabindex", "0");
	await expect(
		page.locator('[data-nodeid="pi:flow-root"][data-handleid="relation-out"]'),
	).toHaveCount(1);
	await expect(
		page.locator('[data-nodeid="pi:flow-child"][data-handleid="relation-in"]'),
	).toHaveCount(1);

	const tabLabels: Array<string | null> = [];
	for (let index = 0; index < 12; index += 1) {
		await page.keyboard.press("Tab");
		tabLabels.push(
			await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
		);
	}
	expect(tabLabels).toContain("root oturumu, flow-root");
	expect(tabLabels).toContain("child oturumu, flow-child");
	expect(tabLabels).toContain("flow-root oturumundan flow-child oturumuna ilişki");

	await rootNode.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("aside")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.locator("aside")).toHaveCount(0);
	await expect(rootNode).not.toHaveClass(/selected/);

	await childNode.focus();
	await page.keyboard.press("Enter");
	const beforeMove = await childNode.getAttribute("style");
	await page.keyboard.press("ArrowRight");
	await expect(childNode).not.toHaveAttribute("style", beforeMove ?? "");
	await expect(page.locator(".react-flow__edge")).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("stable identity updates preserve a moved React Flow node and viewport", async ({page}) => {
	const errors = pageErrors(page);
	const alpha = session("stable-alpha", "/work/alpha");
	const beta = session("stable-beta", "/work/beta");
	const gamma = session("stable-gamma", "/work/gamma");
	let outcome: DiscoveryOutcome = {_tag: "ready", sessions: [alpha, alpha, beta]};
	await routeOutcome(page, () => outcome);
	await page.goto(tuvalUrl);
	await expect(page.locator(".react-flow__node")).toHaveCount(2);
	const pane = page.locator(".react-flow__pane");
	const viewport = page.locator(".react-flow__viewport");
	const paneBounds = await pane.boundingBox();
	expect(paneBounds).not.toBeNull();
	if (paneBounds !== null) {
		await page.mouse.move(paneBounds.x + 720, paneBounds.y + 520);
		await page.mouse.down();
		await page.mouse.move(paneBounds.x + 776, paneBounds.y + 552);
		await page.mouse.up();
	}
	const viewportPosition = await viewport.getAttribute("style");
	const alphaNode = page.locator('[data-id="pi:stable-alpha"]');
	const positionBeforeDrag = /transform:[^;]+/.exec(
		(await alphaNode.getAttribute("style")) ?? "",
	)?.[0];
	expect(positionBeforeDrag).toBeDefined();
	await alphaNode.hover();
	const bounds = await alphaNode.boundingBox();
	expect(bounds).not.toBeNull();
	if (bounds !== null) {
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 32, {
			steps: 8,
		});
		await page.mouse.up();
	}
	await expect
		.poll(async () => /transform:[^;]+/.exec((await alphaNode.getAttribute("style")) ?? "")?.[0])
		.not.toBe(positionBeforeDrag);
	const positionAfterDrag = /transform:[^;]+/.exec(
		(await alphaNode.getAttribute("style")) ?? "",
	)?.[0];

	outcome = {
		_tag: "ready",
		sessions: [{...alpha, cwd: "/work/alpha-renamed"}, gamma],
	};
	await page.locator("#refresh-sessions").click();
	await expect(page.locator('[data-id="pi:stable-gamma"]')).toBeVisible();
	await expect(page.locator('[data-id="pi:stable-beta"]')).toHaveCount(0);
	await expect(page.locator(".react-flow__node")).toHaveCount(2);
	expect(/transform:[^;]+/.exec((await alphaNode.getAttribute("style")) ?? "")?.[0]).toBe(
		positionAfterDrag,
	);
	await expect(viewport).toHaveAttribute("style", viewportPosition ?? "");
	await expect(alphaNode.locator(".session-node__title")).toHaveText("alpha-renamed");
	expect(errors).toEqual([]);
});

test("loading is explicit while discovery is in flight", async ({page}) => {
	const errors = pageErrors(page);
	let discoveryCalls = 0;
	await routeOutcome(
		page,
		() => {
			discoveryCalls += 1;
			return {_tag: "empty", sessions: []};
		},
		300,
	);
	await page.goto(tuvalUrl);
	const retryAction = page.locator("#state-action");
	await expect(page.locator("#status-label")).toHaveText("Oturumlar aranıyor");
	await expect(page.locator("#state-title")).toHaveText("Etkin çalışmalar bulunuyor");
	await expect(retryAction).toBeDisabled();
	await expect(page.locator("#status-label")).toHaveText("Oturum yok");
	expect(discoveryCalls).toBe(1);
	await expect(retryAction).toBeEnabled();

	const retryRequest = page.waitForRequest("**/fate");
	await retryAction.click();
	await retryRequest;
	await expect(retryAction).toBeDisabled();
	await expect.poll(() => discoveryCalls).toBe(2);
	await expect(retryAction).toBeEnabled();
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
		status: "Oturum yok",
		title: "Oturum bulunamadı",
		action: "Yeniden tara",
		nodes: 0,
	},
	{
		name: "partial source",
		outcome: {
			_tag: "partial-source",
			sessions: [session("readable", "/work/readable")],
			problems: [{source: "/fixtures/broken.jsonl", message: "header is not valid JSON"}],
		},
		status: "Kısmi kaynak",
		title: "Bir kaynak okunamadı",
		action: "Keşfi yinele",
		nodes: 1,
	},
	{
		name: "disconnected transport",
		outcome: {_tag: "transport", message: "synthetic connection loss", retryable: true},
		status: "Bağlantı kesildi",
		title: "Tuval pi'ye ulaşamıyor",
		action: "Yeniden bağlan",
		nodes: 0,
	},
	{
		name: "fatal startup",
		outcome: {
			_tag: "fatal",
			message: "Tuval could not read any configured pi session source",
			problems: [{source: "/fixtures/sessions", message: "permission denied"}],
		},
		status: "Başlatma engellendi",
		title: "Oturum kaynağını denetle",
		action: "Yeniden dene",
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
		await expect(page.locator(".react-flow__node")).toHaveCount(stateCase.nodes);
		await expect(page.locator(".status-badge")).toHaveAttribute("data-tone", /.+/);
		expect(errors).toEqual([]);
	});
}

const clearingRefreshCases: ReadonlyArray<{
	readonly name: string;
	readonly outcome: DiscoveryOutcome;
	readonly status: string;
}> = [
	{
		name: "empty",
		outcome: {_tag: "empty", sessions: []},
		status: "Oturum yok",
	},
	{
		name: "transport failure",
		outcome: {_tag: "transport", message: "synthetic connection loss", retryable: true},
		status: "Bağlantı kesildi",
	},
	{
		name: "fatal failure",
		outcome: {
			_tag: "fatal",
			message: "Tuval could not read any configured pi session source",
			problems: [{source: "/fixtures/sessions", message: "permission denied"}],
		},
		status: "Başlatma engellendi",
	},
	{
		name: "incomplete source",
		outcome: {
			_tag: "partial-source",
			sessions: [session("refresh-survivor", "/work/survivor")],
			problems: [{source: "/fixtures/broken.jsonl", message: "header is not valid JSON"}],
		},
		status: "Kısmi kaynak",
	},
];

for (const refreshCase of clearingRefreshCases) {
	test(`${refreshCase.name} refresh releases before clearing the pane and focuses the canvas`, async ({
		page,
	}) => {
		const errors = pageErrors(page);
		await installEventSource(page);
		const selectedSession = session("refresh-selected", "/work/selected");
		const survivor = session("refresh-survivor", "/work/survivor");
		let discoveryCalls = 0;
		let releaseCalls = 0;
		let releaseStarted: (() => void) | undefined;
		let finishRelease: (() => void) | undefined;
		const releaseRequest = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const releaseGate = new Promise<void>((resolve) => {
			finishRelease = resolve;
		});
		await page.route("**/fate", async (route) => {
			const body = route.request().postDataJSON() as {
				readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
			};
			const operation = body.operations?.[0];
			const id = typeof operation?.id === "string" ? operation.id : "unknown";
			if (operation?.name === "discovery") {
				discoveryCalls += 1;
				await fulfill(
					route,
					id,
					discoveryCalls === 1
						? {_tag: "ready", sessions: [selectedSession, survivor]}
						: refreshCase.outcome,
				);
				return;
			}
			if (operation?.name === "liveSession.attach") {
				await fulfill(route, id, {_tag: "attached", session: liveSession("refresh-selected")});
				return;
			}
			releaseCalls += 1;
			releaseStarted?.();
			await releaseGate;
			await fulfill(route, id, {_tag: "released", sessionId: "refresh-selected"});
		});
		await page.goto(tuvalUrl);
		await selectNode(page, "pi:refresh-selected");
		await expect(page.locator("#chat-title")).toHaveText("selected");

		await page.getByRole("button", {name: "Oturumları yenile"}).click();
		await releaseRequest;
		expect(releaseCalls).toBe(1);
		await expect(page.locator("aside")).toHaveCount(1);
		await expect(page.locator("#chat-title")).toHaveText("selected");
		await expect(page.locator("#status-label")).toHaveText("Bağlı");

		finishRelease?.();
		await expect(page.locator("aside")).toHaveCount(0);
		await expect(page.locator("#status-label")).toHaveText(refreshCase.status);
		await expect(page.locator("#canvas")).toBeFocused();
		expect(errors).toEqual([]);
	});
}

test("discovery remains serialized through a stateful release and its live event", async ({
	page,
}) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const selectedSession = session("overlap-selected", "/work/selected");
	const newerSession = session("overlap-newer", "/work/newer");
	let attachment: string | null = null;
	let discoveryCalls = 0;
	let discoveryResponses = 0;
	let releaseCalls = 0;
	let releasedEvents = 0;
	let sequence = 4;
	let releaseStarted: (() => void) | undefined;
	let finishRelease: (() => void) | undefined;
	const releaseRequest = new Promise<void>((resolve) => {
		releaseStarted = resolve;
	});
	const releaseGate = new Promise<void>((resolve) => {
		finishRelease = resolve;
	});
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			discoveryCalls += 1;
			const outcome: DiscoveryOutcome =
				discoveryCalls === 2
					? {_tag: "empty", sessions: []}
					: {
							_tag: "ready",
							sessions: discoveryCalls === 1 ? [selectedSession] : [selectedSession, newerSession],
						};
			await fulfill(route, id, outcome);
			discoveryResponses += 1;
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			attachment = input.sessionId;
			await fulfill(route, id, {_tag: "attached", session: liveSession(input.sessionId)});
			return;
		}
		releaseCalls += 1;
		const releasedSessionId = attachment;
		attachment = null;
		if (releasedSessionId !== null) {
			releasedEvents += 1;
			await emitLive(page, {
				_tag: "released",
				sequence: ++sequence,
				sessionId: releasedSessionId,
			});
		}
		releaseStarted?.();
		await releaseGate;
		await fulfill(route, id, {_tag: "released", sessionId: releasedSessionId});
	});
	await page.goto(tuvalUrl);
	await selectNode(page, "pi:overlap-selected");
	await expect(page.locator("#chat-title")).toHaveText("selected");
	await expect.poll(() => attachment).toBe("overlap-selected");

	const refresh = page.getByRole("button", {name: "Oturumları yenile"});
	await refresh.evaluate((button) => {
		if (!(button instanceof HTMLButtonElement)) throw new Error("refresh control is not a button");
		button.click();
		button.click();
	});
	await releaseRequest;

	await expect(refresh).toBeDisabled();
	await expect.poll(() => discoveryCalls).toBe(2);
	expect(discoveryResponses).toBe(2);
	expect(releaseCalls).toBe(1);
	expect(releasedEvents).toBe(1);
	expect(attachment).toBeNull();
	await expect(page.getByRole("alert")).toContainText("Oturum sahipliği bırakıldı.");

	finishRelease?.();
	await expect(page.locator("aside")).toHaveCount(0);
	await expect(page.locator("#status-label")).toHaveText("Oturum yok");
	await expect(refresh).toBeEnabled();
	expect(discoveryResponses).toBe(2);
	expect(releasedEvents).toBe(1);
	expect(attachment).toBeNull();
	expect(errors).toEqual([]);
});

test("Composer keeps its keyboard focus ring visible while the editor scrolls", async ({
	page,
}, testInfo) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const selectedSession = session("focus-selected", "/work/focus");
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions: [selectedSession]});
			return;
		}
		if (operation?.name === "liveSession.attach") {
			await fulfill(route, id, {_tag: "attached", session: liveSession("focus-selected")});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: "focus-selected"});
	});
	await page.goto(tuvalUrl);
	await selectNode(page, "pi:focus-selected");

	const editor = page.getByRole("textbox", {name: "İstem"});
	await editor.focus();
	await expect(editor).toBeFocused();
	const focusPaint = await editor.evaluate((element) => {
		const shell = element.closest(".tuval-composer");
		if (!(shell instanceof HTMLElement)) throw new Error("Composer shell is missing");
		const editorStyle = getComputedStyle(element);
		const shellStyle = getComputedStyle(shell);
		return {
			outlineWidth: editorStyle.outlineWidth,
			outlineStyle: editorStyle.outlineStyle,
			outlineOffset: editorStyle.outlineOffset,
			editorOverflowY: editorStyle.overflowY,
			editorMaxHeight: editorStyle.maxHeight,
			shellOverflowX: shellStyle.overflowX,
			shellOverflowY: shellStyle.overflowY,
		};
	});
	expect(focusPaint).toEqual({
		outlineWidth: "2px",
		outlineStyle: "solid",
		outlineOffset: "2px",
		editorOverflowY: "auto",
		editorMaxHeight: "180px",
		shellOverflowX: "visible",
		shellOverflowY: "visible",
	});

	const composerBox = await page.locator(".tuval-composer").boundingBox();
	if (composerBox === null) throw new Error("Composer did not render");
	const evidenceInset = 6;
	await testInfo.attach("composer-focus-ring", {
		body: await page.screenshot({
			clip: {
				x: composerBox.x - evidenceInset,
				y: composerBox.y - evidenceInset,
				width: composerBox.width + evidenceInset * 2,
				height: composerBox.height + evidenceInset * 2,
			},
		}),
		contentType: "image/png",
	});

	await editor.fill(Array.from({length: 30}, (_, index) => `satır ${index + 1}`).join("\n"));
	const scrollState = await editor.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		return {
			clientHeight: element.clientHeight,
			scrollHeight: element.scrollHeight,
			scrollTop: element.scrollTop,
		};
	});
	expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
	expect(scrollState.scrollTop).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test("one chat pane swaps sessions, restores focus, and streams Composer prompts", async ({
	page,
}) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const alpha = session("chat-alpha", "/work/alpha");
	const beta = session("chat-beta", "/work/beta");
	let promptText = "";
	let discoveryCalls = 0;
	let discoveryResponses = 0;
	let releaseCalls = 0;
	let finishRefresh: (() => void) | undefined;
	const refreshGate = new Promise<void>((resolve) => {
		finishRefresh = resolve;
	});
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			discoveryCalls += 1;
			if (discoveryCalls === 2) await refreshGate;
			await fulfill(route, id, {_tag: "ready", sessions: [alpha, beta]});
			discoveryResponses += 1;
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			await fulfill(route, id, {_tag: "attached", session: liveSession(input.sessionId)});
			return;
		}
		if (operation?.name === "liveSession.prompt") {
			const input = operation.input as {readonly correlationId: string; readonly text: string};
			promptText = input.text;
			await new Promise((resolve) => setTimeout(resolve, 200));
			await fulfill(route, id, {
				_tag: "acknowledged",
				correlationId: input.correlationId,
				session: liveSession("chat-alpha", 2, [
					...liveSession("chat-alpha").transcript,
					{
						id: "prompt-user",
						role: "user",
						content: [{type: "text", text: input.text}],
						timestamp: 2,
						status: "complete",
					},
				]),
			});
			return;
		}
		releaseCalls += 1;
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);

	await selectNode(page, "pi:chat-alpha");
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.locator("#chat-title")).toHaveText("alpha");
	await expect(page.getByText("chat-alpha mevcut konuşma")).toBeVisible();

	await selectNode(page, "pi:chat-beta");
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.locator("#chat-title")).toHaveText("beta");
	await expect(page.getByText("chat-beta mevcut konuşma")).toBeVisible();

	await page.getByRole("button", {name: "Oturumları yenile"}).click();
	await expect.poll(() => discoveryCalls).toBe(2);
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.locator("#chat-title")).toHaveText("beta");
	expect(releaseCalls).toBe(0);
	finishRefresh?.();
	await expect.poll(() => discoveryResponses).toBe(2);
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.locator("#chat-title")).toHaveText("beta");

	await page.getByRole("button", {name: "Sohbeti kapat"}).click();
	await expect(page.locator("aside")).toHaveCount(0);
	await expect(page.locator('[data-id="pi:chat-beta"]')).toBeFocused();
	await expect.poll(() => releaseCalls).toBe(1);

	await selectNode(page, "pi:chat-alpha");
	const editor = page.getByRole("textbox", {name: "İstem"});
	await editor.fill("ilk satır");
	await editor.press("Shift+Enter");
	await editor.type("ikinci satır");
	const beforeEntries = await page.locator(".transcript-entry").count();
	await editor.press("Enter");
	await expect(page.getByText("Gönderiliyor; onay bekleniyor.")).toBeVisible();
	await expect(page.locator(".transcript-entry")).toHaveCount(beforeEntries);
	await expect(page.getByText("İleti pi tarafından onaylandı.")).toBeVisible();
	expect(promptText).toContain("ilk satır");
	expect(promptText).toContain("ikinci satır");
	await expect(editor).toBeEmpty();

	await emitLive(page, {
		_tag: "session",
		sequence: 9,
		session: {
			...liveSession("chat-alpha", 3, [
				...liveSession("chat-alpha").transcript,
				{
					id: "streamed",
					role: "assistant",
					content: [{type: "text", text: "Akıştan geldi"}],
					timestamp: 3,
					status: "error",
				},
			]),
			phase: "idle",
			completion: "error",
			lastEventSequence: 9,
		},
	});
	await expect(page.getByText("Akıştan geldi")).toBeVisible();
	await expect(page.getByText("Tur hatayla sonlandı")).toBeVisible();
	expect(errors).toEqual([]);
});

test("an original prompt completion cannot corrupt a newly attached pane after an ABA swap", async ({
	page,
}) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const alpha = session("prompt-alpha", "/work/alpha");
	const beta = session("prompt-beta", "/work/beta");
	let finishOriginalAlpha: (() => void) | undefined;
	let originalAlphaResponses = 0;
	let alphaAttachments = 0;
	const originalAlphaGate = new Promise<void>((resolve) => {
		finishOriginalAlpha = resolve;
	});
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions: [alpha, beta]});
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			if (input.sessionId === "prompt-alpha") alphaAttachments += 1;
			await fulfill(route, id, {
				_tag: "attached",
				session: liveSession(
					input.sessionId,
					input.sessionId === "prompt-alpha" ? alphaAttachments : 1,
				),
			});
			return;
		}
		if (operation?.name === "liveSession.prompt") {
			const input = operation.input as {readonly correlationId: string};
			await originalAlphaGate;
			await fulfill(route, id, {
				_tag: "refused",
				correlationId: input.correlationId,
				code: "lease-refused",
				reason: "Eski Alpha sahipliği artık geçerli değil.",
			});
			originalAlphaResponses += 1;
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);

	await selectNode(page, "pi:prompt-alpha");
	const originalAlphaEditor = page.getByRole("textbox", {name: "İstem"});
	await originalAlphaEditor.fill("özgün alpha istemi");
	await originalAlphaEditor.press("Enter");
	await expect(page.getByText("Gönderiliyor; onay bekleniyor.")).toBeVisible();

	await selectNode(page, "pi:prompt-beta");
	await expect(page.locator("#chat-title")).toHaveText("beta");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	await selectNode(page, "pi:prompt-alpha");
	await expect.poll(() => alphaAttachments).toBe(2);
	await expect(page.locator("#chat-title")).toHaveText("alpha");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	const newAlphaSubmit = page.locator('.composer-shell button[type="submit"]');
	await expect(newAlphaSubmit).toBeEnabled();

	finishOriginalAlpha?.();
	await expect.poll(() => originalAlphaResponses).toBe(1);
	await expect(page.locator("#chat-title")).toHaveText("alpha");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	await expect(page.getByText("Eski Alpha sahipliği artık geçerli değil.")).toHaveCount(0);
	await expect(page.getByText("Oturum açılamadı")).toHaveCount(0);
	await expect(page.getByText("Gönderiliyor; onay bekleniyor.")).toHaveCount(0);
	await expect(newAlphaSubmit).toBeEnabled();
	expect(errors).toEqual([]);
});

test("ownership, disconnect, malformed stream, and send failures are accessible", async ({
	page,
}) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const alpha = session("error-alpha", "/work/alpha");
	const beta = session("error-beta", "/work/beta");
	let promptFails = false;
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions: [alpha, beta]});
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			if (input.sessionId === "error-beta") {
				await fulfill(route, id, {
					_tag: "refused",
					sessionId: input.sessionId,
					code: "lease-refused",
					reason: "Oturum başka bir çalışma alanında açık.",
				});
			} else {
				await fulfill(route, id, {_tag: "attached", session: liveSession(input.sessionId)});
			}
			return;
		}
		if (operation?.name === "liveSession.prompt" && promptFails) {
			const input = operation.input as {readonly correlationId: string};
			await fulfill(route, id, {
				_tag: "refused",
				correlationId: input.correlationId,
				code: "protocol",
				reason: "İleti gönderilemedi.",
			});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);

	await selectNode(page, "pi:error-beta");
	await expect(page.getByRole("alert")).toContainText("Oturum açılamadı");
	await expect(page.getByRole("alert")).toContainText("başka bir çalışma alanında");

	await selectNode(page, "pi:error-alpha");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	await emitLive(page, {
		_tag: "session",
		sequence: 9,
		session: {
			...liveSession("error-alpha"),
			transcript: [
				{
					id: "malformed-tool",
					role: "assistant",
					content: [{type: "toolCall", toolCallId: "call-1", toolName: "read"}],
					timestamp: 2,
					status: "running",
				},
			],
			lastEventSequence: 9,
		},
	});
	await expect(page.getByRole("alert")).toContainText("Canlı akış okunamadı");

	await selectNode(page, "pi:error-beta");
	await expect(page.getByRole("alert")).toContainText("Oturum açılamadı");
	await selectNode(page, "pi:error-alpha");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	await disconnectLive(page);
	await expect(page.getByRole("alert")).toContainText("Bağlantı kesildi");

	await selectNode(page, "pi:error-beta");
	await expect(page.getByRole("alert")).toContainText("Oturum açılamadı");
	await selectNode(page, "pi:error-alpha");
	await expect(page.getByText("Canlı", {exact: true})).toBeVisible();
	promptFails = true;
	const editor = page.getByRole("textbox", {name: "İstem"});
	await editor.fill("başarısız gönderim");
	await editor.press("Enter");
	await expect(page.getByRole("alert")).toContainText("İleti gönderilemedi");
	expect(errors).toEqual([]);
});
