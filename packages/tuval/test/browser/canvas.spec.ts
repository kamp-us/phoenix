import {type ChildProcess, spawn} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, type Locator, type Page, type Route, test} from "@playwright/test";
import type {DiscoveredSession, DiscoveryOutcome} from "../../src/shared/discovery.js";
import type {LineageProjection} from "../../src/shared/lineage.js";
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

const lineageProjection = (sessions: ReadonlyArray<DiscoveredSession>): LineageProjection => {
	const unique = [...new Map(sessions.map((value) => [value.identity, value])).values()];
	return {
		graph: {
			version: 2,
			nodes: unique.map((value) => ({
				id: value.identity,
				piSessionId: value.piSessionId,
				createdAt: value.createdAt,
				updatedAt: value.updatedAt,
				cwd: value.cwd,
				sourceFiles: [value.sourceFile],
			})),
			edges: unique.flatMap((value) => {
				if (value.parentSessionId === undefined) return [];
				const parent = unique.find((candidate) => candidate.piSessionId === value.parentSessionId);
				return parent === undefined
					? []
					: [
							{
								id: `fork:${value.identity}`,
								kind: "fork" as const,
								parent: parent.identity,
								child: value.identity,
								source: "protocol" as const,
							},
						];
			}),
			continuity: [],
			ownership: [],
		},
		problems: [],
	};
};

const sessionsFrom = (outcome: DiscoveryOutcome): ReadonlyArray<DiscoveredSession> =>
	outcome._tag === "ready" || outcome._tag === "partial-source" ? outcome.sessions : [];

const routeOutcome = async (
	page: Page,
	outcome: () => DiscoveryOutcome,
	delay = 0,
	lineage?: () => LineageProjection,
): Promise<void> => {
	let latest: DiscoveryOutcome | undefined;
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			latest = outcome();
			await fulfill(route, id, latest);
			return;
		}
		if (operation?.name === "lineage") {
			await fulfill(
				route,
				id,
				lineage?.() ?? lineageProjection(latest === undefined ? [] : sessionsFrom(latest)),
			);
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

const blankPanePoint = async (pane: Locator) =>
	pane.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		for (let y = bounds.top + 24; y < bounds.bottom - 24; y += 24) {
			for (let x = bounds.left + 24; x < bounds.right - 24; x += 24) {
				if (document.elementFromPoint(x, y) === element) return {x, y};
			}
		}
		return null;
	});

interface RasterStats {
	readonly paintedPixels: number;
	readonly solidPixels: number;
	readonly contrast: number;
}

const edgeRasterStats = async (
	page: Page,
	edgeId: string,
	clip: {readonly x: number; readonly y: number; readonly width: number; readonly height: number},
	mode: "edge" | "marker" = "edge",
): Promise<RasterStats> => {
	const captureClip = {
		x: Math.max(0, clip.x),
		y: Math.max(0, clip.y),
		width: Math.max(1, clip.width),
		height: Math.max(1, clip.height),
	};
	const target = page.locator(
		mode === "edge"
			? `.react-flow__edge[data-id="${edgeId}"]`
			: `.react-flow__edge[data-id="${edgeId}"] .relationship-edge`,
	);
	const painted = await page.screenshot({clip: captureClip});
	const previous = await target.evaluate((element, paintMode) => {
		if (paintMode === "marker") {
			const value = element.getAttribute("marker-end");
			element.removeAttribute("marker-end");
			return {attribute: "marker-end", value};
		}
		const value = element.getAttribute("style");
		if (!(element instanceof SVGElement)) throw new Error("relationship edge is not SVG");
		element.style.opacity = "0";
		return {attribute: "style", value};
	}, mode);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	const hidden = await page.screenshot({clip: captureClip});
	await target.evaluate((element, state) => {
		if (state.value === null) element.removeAttribute(state.attribute);
		else element.setAttribute(state.attribute, state.value);
	}, previous);
	return await page.evaluate(
		async ({paintedSource, hiddenSource}) => {
			const decode = async (source: string): Promise<ImageData> => {
				const image = new Image();
				image.src = `data:image/png;base64,${source}`;
				await image.decode();
				const canvas = document.createElement("canvas");
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const context = canvas.getContext("2d", {willReadFrequently: true});
				if (context === null) throw new Error("Chromium did not provide a 2D capture context");
				context.drawImage(image, 0, 0);
				return context.getImageData(0, 0, canvas.width, canvas.height);
			};
			const visible = await decode(paintedSource);
			const background = await decode(hiddenSource);
			const luminance = (r: number, g: number, b: number): number => {
				const channel = (value: number): number => {
					const normalized = value / 255;
					return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
			};
			let paintedPixels = 0;
			let solidPixels = 0;
			let contrast = 1;
			for (let index = 0; index < visible.data.length; index += 4) {
				const delta = Math.max(
					Math.abs((visible.data[index] ?? 0) - (background.data[index] ?? 0)),
					Math.abs((visible.data[index + 1] ?? 0) - (background.data[index + 1] ?? 0)),
					Math.abs((visible.data[index + 2] ?? 0) - (background.data[index + 2] ?? 0)),
				);
				if (delta >= 4) paintedPixels += 1;
				if (delta >= 32) solidPixels += 1;
				if (delta >= 32) {
					const foregroundLight = luminance(
						visible.data[index] ?? 0,
						visible.data[index + 1] ?? 0,
						visible.data[index + 2] ?? 0,
					);
					const backgroundLight = luminance(
						background.data[index] ?? 0,
						background.data[index + 1] ?? 0,
						background.data[index + 2] ?? 0,
					);
					contrast = Math.max(
						contrast,
						(Math.max(foregroundLight, backgroundLight) + 0.05) /
							(Math.min(foregroundLight, backgroundLight) + 0.05),
					);
				}
			}
			return {paintedPixels, solidPixels, contrast};
		},
		{paintedSource: painted.toString("base64"), hiddenSource: hidden.toString("base64")},
	);
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
	const start = await blankPanePoint(pane);
	expect(start).not.toBeNull();
	if (start !== null) {
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 64, start.y + 40, {steps: 8});
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
	const edge = page.locator('[data-id="fork:pi:flow-child"]');
	await expect(rootNode).toHaveAttribute("aria-label", "root oturumu, flow-root");
	await expect(childNode).toHaveAttribute("aria-label", "child oturumu, flow-child");
	await expect(edge).toHaveAttribute(
		"aria-label",
		"flow-root oturumundan flow-child oturumuna dallanma ilişkisi, kaynak protocol",
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
	expect(tabLabels).toContain(
		"flow-root oturumundan flow-child oturumuna dallanma ilişkisi, kaynak protocol",
	);

	await rootNode.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("aside")).toHaveCount(1);
	await expect(page.getByRole("alert")).toContainText("Bağlantı kesildi");
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

test("coincident spawn and fork relations paint distinct strokes and a visible arrowhead", async ({
	page,
}, testInfo) => {
	const errors = pageErrors(page);
	const root = session("coincident-root", "/work/root");
	const child = session("coincident-child", "/work/child");
	const base = lineageProjection([root, child]);
	const projection: LineageProjection = {
		...base,
		graph: {
			...base.graph,
			edges: [
				{
					id: "spawn:coincident",
					kind: "spawn",
					parent: root.identity,
					child: child.identity,
					runId: "coincident",
					observedAt: 1,
				},
				{
					id: `fork:${child.identity}`,
					kind: "fork",
					parent: root.identity,
					child: child.identity,
					source: "protocol",
				},
			],
		},
	};
	await routeOutcome(
		page,
		() => ({_tag: "ready", sessions: [root, child]}),
		0,
		() => projection,
	);
	await page.goto(tuvalUrl);

	const spawn = page.locator('[data-id="spawn:coincident"] .relationship-edge');
	const fork = page.locator(`[data-id="fork:${child.identity}"] .relationship-edge`);
	await expect(spawn).toBeVisible();
	await expect(fork).toBeVisible();
	await expect(spawn).not.toHaveAttribute("d", (await fork.getAttribute("d")) ?? "");

	const capturePath = testInfo.outputPath("coincident-lineage-canvas.png");
	await page.screenshot({path: capturePath, fullPage: true});
	await testInfo.attach("coincident-lineage-canvas", {
		path: capturePath,
		contentType: "image/png",
	});

	const spawnBox = await spawn.boundingBox();
	const forkBox = await fork.boundingBox();
	if (spawnBox === null || forkBox === null)
		throw new Error("coincident edge paths did not render");
	const spawnPixels = await edgeRasterStats(page, "spawn:coincident", {
		x: spawnBox.x - 8,
		y: spawnBox.y - 8,
		width: spawnBox.width + 16,
		height: spawnBox.height + 16,
	});
	const forkPixels = await edgeRasterStats(page, `fork:${child.identity}`, {
		x: forkBox.x - 8,
		y: forkBox.y - 8,
		width: forkBox.width + 16,
		height: forkBox.height + 16,
	});
	expect(spawnPixels.paintedPixels).toBeGreaterThan(80);
	expect(spawnPixels.solidPixels).toBeGreaterThan(20);
	expect(spawnPixels.contrast).toBeGreaterThanOrEqual(3);
	expect(forkPixels.paintedPixels).toBeGreaterThan(40);
	expect(forkPixels.contrast).toBeGreaterThanOrEqual(3);

	const targetHandle = page.locator(
		`[data-nodeid="${child.identity}"][data-handleid="relation-in"]`,
	);
	const targetBox = await targetHandle.boundingBox();
	if (targetBox === null) throw new Error("coincident target handle did not render");
	const arrowPixels = await edgeRasterStats(
		page,
		"spawn:coincident",
		{
			x: targetBox.x - 28,
			y: targetBox.y - 12,
			width: 32,
			height: targetBox.height + 24,
		},
		"marker",
	);
	expect(arrowPixels.solidPixels).toBeGreaterThan(24);
	expect(arrowPixels.contrast).toBeGreaterThanOrEqual(3);

	expect(errors).toEqual([]);
});

test("typed lineage stays readable and durable across dense problems and a conflicting refresh", async ({
	page,
}, testInfo) => {
	const errors = pageErrors(page);
	const root = session("lineage-root", "/work/root");
	const children = Array.from({length: 12}, (_, index) =>
		session(`lineage-child-${index + 1}`, `/work/child-${index + 1}`),
	);
	const sessions = [root, ...children];
	const base = lineageProjection(sessions);
	const projection: LineageProjection = {
		...base,
		graph: {
			...base.graph,
			edges: [
				...children.map((child, index) =>
					index % 2 === 0
						? {
								id: `spawn:dense-${index + 1}`,
								kind: "spawn" as const,
								parent: root.identity,
								child: child.identity,
								runId: `dense-${index + 1}`,
								observedAt: index + 1,
							}
						: {
								id: `fork:${child.identity}`,
								kind: "fork" as const,
								parent: root.identity,
								child: child.identity,
								source: "protocol" as const,
							},
				),
				{
					id: "spawn:dense-skip-parent",
					kind: "spawn" as const,
					parent: children[3]!.identity,
					child: children[1]!.identity,
					runId: "dense-skip-parent",
					observedAt: 20,
				},
			],
			continuity: [
				{
					id: "resume:dense-resume",
					runId: "dense-resume",
					session: children[0]?.identity ?? root.identity,
					parent: root.identity,
					observedAt: 100,
				},
			],
		},
		problems: [
			{code: "unresolved-session", source: "run:unjoined", message: "parent is not joined"},
			{code: "malformed-run", source: "run:broken", message: "status entry is malformed"},
			{code: "retention-loss", source: "run:expired", message: "source artifact expired"},
			{
				code: "protocol-unavailable",
				source: "pi-protocol",
				message: "metadata transport unavailable",
			},
		],
	};
	let lineageCalls = 0;
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions});
			return;
		}
		if (operation?.name === "lineage") {
			lineageCalls += 1;
			if (lineageCalls === 1) {
				await fulfill(route, id, projection);
			} else {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						version: 1,
						results: [{id, ok: false, error: {message: "conflicting lineage record"}}],
					}),
				});
			}
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			await fulfill(route, id, {
				_tag: "refused",
				sessionId: input.sessionId,
				code: "disconnected",
				reason: "test live transport is unavailable",
			});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);
	await page.locator(".detail-setting").getByText("Tam", {exact: true}).click();

	await expect(page.locator(".react-flow__node")).toHaveCount(13);
	await expect(page.locator(".react-flow__edge")).toHaveCount(13);
	await expect(page.locator('.canvas-legend [data-kind="spawn"]')).toContainText(
		"Oluşturma · düz ok",
	);
	await expect(page.locator('.canvas-legend [data-kind="fork"]')).toContainText(
		"Dallanma · kesik çizgi",
	);
	await expect(page.locator(".relationship-edge--spawn").first()).toHaveAttribute(
		"marker-end",
		/.+/,
	);
	const forkDash = await page
		.locator(".relationship-edge--fork")
		.first()
		.evaluate((element) => getComputedStyle(element).strokeDasharray);
	expect(forkDash).not.toBe("none");
	await expect(page.locator(`[data-id="${children[0]?.identity}"]`)).toHaveAttribute(
		"aria-label",
		/1 devam kaydı/,
	);
	await expect(page.getByText("1 devam")).toBeVisible();
	await expect(page.locator('[data-id^="resume:"]')).toHaveCount(0);
	await expect(page.getByText("Birleşmemiş oturum")).toBeVisible();
	await expect(page.getByText("Bozuk kayıt")).toBeVisible();
	await expect(page.getByText("Kaynağı artık yok")).toBeVisible();
	const edgeNodeIntersections = await page.evaluate(
		(relationships) => {
			const collisions: Array<string> = [];
			for (const relationship of relationships) {
				const path = document.querySelector<SVGPathElement>(
					`.react-flow__edge[data-id="${relationship.id}"] .relationship-edge`,
				);
				const matrix = path?.getScreenCTM();
				if (path === null || path === undefined || matrix === null || matrix === undefined) {
					collisions.push(`${relationship.id}:missing-path`);
					continue;
				}
				const unrelated = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].filter(
					(node) =>
						node.dataset.id !== relationship.parent && node.dataset.id !== relationship.child,
				);
				const length = path.getTotalLength();
				for (let sample = 1; sample < 100; sample += 1) {
					const point = path.getPointAtLength((length * sample) / 100).matrixTransform(matrix);
					for (const node of unrelated) {
						const bounds = node.getBoundingClientRect();
						if (
							point.x > bounds.left + 1 &&
							point.x < bounds.right - 1 &&
							point.y > bounds.top + 1 &&
							point.y < bounds.bottom - 1
						) {
							collisions.push(`${relationship.id}:${node.dataset.id ?? "unknown"}`);
						}
					}
				}
			}
			return [...new Set(collisions)];
		},
		projection.graph.edges.map(({id, parent, child}) => ({id, parent, child})),
	);
	expect(edgeNodeIntersections).toEqual([]);
	const stageBox = await page.locator("#canvas-stage").boundingBox();
	const problemBox = await page.locator(".lineage-problems").boundingBox();
	if (stageBox === null || problemBox === null)
		throw new Error("dense canvas regions did not render");
	expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(problemBox.x);
	for (const nodeElement of await page.locator(".react-flow__node").all()) {
		const nodeBox = await nodeElement.boundingBox();
		if (nodeBox === null) throw new Error("dense lineage node did not render");
		expect(
			nodeBox.x + nodeBox.width <= problemBox.x || nodeBox.x >= problemBox.x + problemBox.width,
		).toBe(true);
	}
	const capturePath = testInfo.outputPath("lineage-canvas.png");
	await page.screenshot({path: capturePath, fullPage: true});
	await testInfo.attach("lineage-canvas", {path: capturePath, contentType: "image/png"});

	const viewport = page.locator(".react-flow__viewport");
	const pane = page.locator(".react-flow__pane");
	const beforePan = await viewport.getAttribute("style");
	const paneBounds = await pane.boundingBox();
	if (paneBounds === null) throw new Error("dense lineage pane did not render");
	await page.mouse.move(paneBounds.x + 40, paneBounds.y + 300);
	await page.mouse.down();
	await page.mouse.move(paneBounds.x + 96, paneBounds.y + 332);
	await page.mouse.up();
	await expect(viewport).not.toHaveAttribute("style", beforePan ?? "");
	const beforeZoom = await viewport.getAttribute("style");
	await page.getByRole("button", {name: "Yakınlaştır"}).click();
	await expect(viewport).not.toHaveAttribute("style", beforeZoom ?? "");
	const edge = page.locator('[data-id="spawn:dense-1"]');
	await edge.focus();
	await page.keyboard.press("Enter");
	await expect(edge).toHaveClass(/selected/);

	await page.getByRole("button", {name: "Oturumları yenile"}).click();
	await expect(page.getByText("Çakışan veya okunamayan bağ verisi")).toBeVisible();
	await expect(page.locator(".react-flow__node")).toHaveCount(13);
	await expect(page.locator(".react-flow__edge")).toHaveCount(13);
	expect(errors).toEqual([]);
});

test("an initial lineage failure keeps discovered sessions as truthful nodes without edges", async ({
	page,
}) => {
	const errors = pageErrors(page);
	const root = session("known-root", "/work/known-root");
	const child = session("known-child", "/work/known-child", "known-root");
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions: [root, child]});
			return;
		}
		if (operation?.name === "lineage") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					version: 1,
					results: [{id, ok: false, error: {message: "initial lineage conflict"}}],
				}),
			});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);

	await expect(page.locator(".react-flow__node")).toHaveCount(2);
	await expect(page.locator('[data-id="pi:known-root"]')).toBeVisible();
	await expect(page.locator('[data-id="pi:known-child"]')).toBeVisible();
	await expect(page.locator(".react-flow__edge")).toHaveCount(0);
	await expect(page.getByText("Çakışan veya okunamayan bağ verisi")).toBeVisible();
	expect(errors).toEqual([]);
});

test("all four persisted detail levels preserve the live React Flow interaction contract", async ({
	page,
}, testInfo) => {
	const errors = pageErrors(page);
	await installEventSource(page);
	const root = session("detail-root", "/work/detail-root");
	const stalled = session("detail-stalled", "/work/detail-stalled", "detail-root");
	const completed = session("detail-completed", "/work/detail-completed", "detail-root");
	const failed = session("detail-failed", "/work/detail-failed", "detail-stalled");
	const sessions = [root, stalled, completed, failed];
	await page.route("**/fate", async (route) => {
		const body = route.request().postDataJSON() as {
			readonly operations?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		};
		const operation = body.operations?.[0];
		const id = typeof operation?.id === "string" ? operation.id : "unknown";
		if (operation?.name === "discovery") {
			await fulfill(route, id, {_tag: "ready", sessions});
			return;
		}
		if (operation?.name === "lineage") {
			await fulfill(route, id, lineageProjection(sessions));
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			await fulfill(route, id, {
				_tag: "attached",
				session: {
					...liveSession(input.sessionId),
					phase: "retry",
					completion: "running",
				},
			});
			return;
		}
		await fulfill(route, id, {_tag: "released", sessionId: null});
	});
	await page.goto(tuvalUrl);
	await expect(page.locator(".react-flow__node")).toHaveCount(4);
	await expect(page.locator(".react-flow__edge")).toHaveCount(3);

	const levels = [
		{value: "bare", label: "Sade"},
		{value: "meta", label: "Meta"},
		{value: "live", label: "Canlı"},
		{value: "full", label: "Tam"},
	] as const;
	const pane = page.locator(".react-flow__pane");
	const viewport = page.locator(".react-flow__viewport");
	const relationship = page.locator('[data-id="fork:pi:detail-stalled"]');
	for (const level of levels) {
		await page.locator(".detail-setting").getByText(level.label, {exact: true}).click();
		await expect(page.locator(`.session-node[data-detail-level="${level.value}"]`)).toHaveCount(4);
		await expect(page.locator(".react-flow__edge")).toHaveCount(3);
		await expect(page.locator(".relationship-edge").first()).toBeVisible();
		const nodeBoxes = await page.locator(".react-flow__node").evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return {left: box.left, right: box.right, top: box.top, bottom: box.bottom};
			}),
		);
		for (let leftIndex = 0; leftIndex < nodeBoxes.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < nodeBoxes.length; rightIndex += 1) {
				const left = nodeBoxes[leftIndex]!;
				const right = nodeBoxes[rightIndex]!;
				const overlaps =
					left.left < right.right &&
					left.right > right.left &&
					left.top < right.bottom &&
					left.bottom > right.top;
				expect(overlaps).toBe(false);
			}
		}

		const beforePan = await viewport.getAttribute("style");
		const start = await blankPanePoint(pane);
		expect(start).not.toBeNull();
		if (start !== null) {
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x + 24, start.y + 16, {steps: 4});
			await page.mouse.up();
		}
		await expect(viewport).not.toHaveAttribute("style", beforePan ?? "");
		const beforeZoom = await viewport.getAttribute("style");
		await page.getByRole("button", {name: "Yakınlaştır"}).click();
		await expect(viewport).not.toHaveAttribute("style", beforeZoom ?? "");

		await relationship.focus();
		await page.keyboard.press("Enter");
		await expect(relationship).toHaveClass(/selected/);
		await page.keyboard.press("Escape");
		await expect(relationship).not.toHaveClass(/selected/);
		await page.getByRole("button", {name: "Tümünü göster"}).click();

		const capturePath = testInfo.outputPath(`node-detail-${level.value}.png`);
		await page.screenshot({path: capturePath, fullPage: true});
		await testInfo.attach(`node-detail-${level.value}`, {
			path: capturePath,
			contentType: "image/png",
		});
	}

	await page.locator(".detail-setting").getByText("Canlı", {exact: true}).click();
	await selectNode(page, stalled.identity);
	await expect(page.locator(`[data-id="${stalled.identity}"]`)).toContainText("Protokol canlı");
	await expect(page.locator(`[data-id="${stalled.identity}"]`)).toContainText("Takıldı");
	await expect(page.locator("#chat-title")).toHaveText("detail-stalled");
	await page.locator(".chat-pane").evaluate(async (element) => {
		await Promise.all(element.getAnimations().map((animation) => animation.finished));
	});
	const attachedCapturePath = testInfo.outputPath("node-detail-live-attached.png");
	await page.screenshot({path: attachedCapturePath, fullPage: true});
	await testInfo.attach("node-detail-live-attached", {
		path: attachedCapturePath,
		contentType: "image/png",
	});
	await page.getByRole("button", {name: "Sohbeti kapat"}).click();
	await expect(page.locator("aside")).toHaveCount(0);
	await page.locator(".detail-setting").getByText("Tam", {exact: true}).click();

	await page.reload();
	await expect(page.locator('.session-node[data-detail-level="full"]')).toHaveCount(4);
	await expect(page.locator(".detail-setting").getByText("Tam", {exact: true})).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.locator(".react-flow__edge")).toHaveCount(3);
	expect(await page.evaluate(() => localStorage.getItem("tuval.workspace.node-detail-level"))).toBe(
		"full",
	);
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
			if (operation?.name === "lineage") {
				await fulfill(
					route,
					id,
					lineageProjection(
						discoveryCalls === 1 ? [selectedSession, survivor] : sessionsFrom(refreshCase.outcome),
					),
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
		if (operation?.name === "lineage") {
			const sessions =
				discoveryCalls === 2
					? []
					: discoveryCalls === 1
						? [selectedSession]
						: [selectedSession, newerSession];
			await fulfill(route, id, lineageProjection(sessions));
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
		if (operation?.name === "lineage") {
			await fulfill(route, id, lineageProjection([selectedSession]));
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
	let finishBetaAttach: (() => void) | undefined;
	let finishPrompt: (() => void) | undefined;
	const refreshGate = new Promise<void>((resolve) => {
		finishRefresh = resolve;
	});
	const betaAttachGate = new Promise<void>((resolve) => {
		finishBetaAttach = resolve;
	});
	const promptGate = new Promise<void>((resolve) => {
		finishPrompt = resolve;
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
		if (operation?.name === "lineage") {
			await fulfill(route, id, lineageProjection([alpha, beta]));
			return;
		}
		if (operation?.name === "liveSession.attach") {
			const input = operation.input as {readonly sessionId: string};
			if (input.sessionId === "chat-beta") await betaAttachGate;
			await fulfill(route, id, {_tag: "attached", session: liveSession(input.sessionId)});
			return;
		}
		if (operation?.name === "liveSession.prompt") {
			const input = operation.input as {readonly correlationId: string; readonly text: string};
			promptText = input.text;
			await promptGate;
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
	await expect(page.getByText("Bağlanıyor", {exact: true})).toBeVisible();
	await expect(page.getByText("chat-alpha mevcut konuşma")).toHaveCount(0);
	finishBetaAttach?.();
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

	const newestSession = {
		...liveSession("chat-alpha", 3, [
			...liveSession("chat-alpha").transcript,
			{
				id: "streamed",
				role: "assistant" as const,
				content: [{type: "text" as const, text: "Akıştan geldi"}],
				timestamp: 3,
				status: "error" as const,
			},
		]),
		phase: "idle" as const,
		completion: "error" as const,
		lastEventSequence: 9,
	};
	await emitLive(page, {_tag: "session", sequence: 9, session: newestSession});
	await expect(page.getByText("Akıştan geldi")).toBeVisible();
	await expect(page.getByText("Tur hatayla sonlandı")).toBeVisible();

	finishPrompt?.();
	await expect(page.getByText("İleti pi tarafından onaylandı.")).toBeVisible();
	expect(promptText).toContain("ilk satır");
	expect(promptText).toContain("ikinci satır");
	await expect(editor).toBeEmpty();
	await expect(page.getByText("Akıştan geldi")).toBeVisible();
	await expect(page.getByText("Tur hatayla sonlandı")).toBeVisible();

	await emitLive(page, {
		_tag: "session",
		sequence: 8,
		session: liveSession("chat-alpha", 2),
	});
	await emitLive(page, {
		_tag: "session",
		sequence: 9,
		session: liveSession("chat-alpha", 2),
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
		if (operation?.name === "lineage") {
			await fulfill(route, id, lineageProjection([alpha, beta]));
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
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
	await selectNode(page, "pi:prompt-alpha");
	await expect.poll(() => alphaAttachments).toBe(2);
	await expect(page.locator("#chat-title")).toHaveText("alpha");
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
	const newAlphaSubmit = page.locator('.composer-shell button[type="submit"]');
	await expect(newAlphaSubmit).toBeEnabled();

	finishOriginalAlpha?.();
	await expect.poll(() => originalAlphaResponses).toBe(1);
	await expect(page.locator("#chat-title")).toHaveText("alpha");
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
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
		if (operation?.name === "lineage") {
			await fulfill(route, id, lineageProjection([alpha, beta]));
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
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
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
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
	await disconnectLive(page);
	await expect(page.getByRole("alert")).toContainText("Bağlantı kesildi");

	await selectNode(page, "pi:error-beta");
	await expect(page.getByRole("alert")).toContainText("Oturum açılamadı");
	await selectNode(page, "pi:error-alpha");
	await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible();
	promptFails = true;
	const editor = page.getByRole("textbox", {name: "İstem"});
	await editor.fill("başarısız gönderim");
	await editor.press("Enter");
	await expect(page.getByRole("alert")).toContainText("İleti gönderilemedi");
	expect(errors).toEqual([]);
});
