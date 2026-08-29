import {type ChildProcess, spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, type Page, test} from "@playwright/test";

const harness = fileURLToPath(new URL("./daily-driver-server.mjs", import.meta.url));

const startServer = async (root: string, port: number) => {
	const child = spawn(process.execPath, [harness, String(port)], {
		env: {...process.env, TUVAL_DAILY_DRIVER_ROOT: root},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = await new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("daily-driver server did not report readiness within 10 seconds")),
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
			reject(new Error(`daily-driver server exited before readiness (${code}): ${stderr}`));
		});
	});
	return {child, url};
};

const stopServer = async (child: ChildProcess | undefined) => {
	if (child === undefined || child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

const snapshot = (id: string, cwd: string, createdAt: number) => ({
	id,
	cwd,
	createdAt,
	updatedAt: createdAt,
	phase: "idle",
	model: {provider: "synthetic", id: "daily-driver"},
	thinkingLevel: "high",
	attached: true,
	locked: false,
	revision: 1,
	transcript: [
		{
			id: `${id}-existing`,
			role: "user",
			content: [{type: "text", text: `${id} kalıcı konuşma`}],
			timestamp: createdAt,
		},
	],
	queuedSteer: [],
	queuedSteerCount: 0,
});

const writeSession = async (
	directory: string,
	id: string,
	cwd: string,
	parentSessionId?: string,
) => {
	const path = join(directory, `2026-08-29T10-00-00-000Z_${id}.jsonl`);
	await writeFile(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-08-29T10:00:00.000Z",
			cwd,
			...(parentSessionId === undefined ? {} : {parentSessionId}),
		})}\n`,
	);
	return path;
};

const attachErrors = (page: Page, errors: Array<string>) => {
	page.on("pageerror", (error) => errors.push(error.message));
};

const selectNode = async (page: Page, identity: string) => {
	const node = page.locator(`[data-id="${identity}"]`);
	await node.focus();
	await node.press("Enter");
};

test("real daily-driver survives mounted reconnect, cold restore, and one independently corrupt source", async ({
	browser,
}, testInfo) => {
	test.setTimeout(60_000);
	const root = await mkdtemp(join(tmpdir(), "tuval-daily-driver-"));
	const sessions = join(root, "sessions", "--daily-driver");
	const stateDirectory = join(root, "tuval");
	await mkdir(sessions, {recursive: true});
	await mkdir(stateDirectory, {recursive: true});
	const parentPath = await writeSession(sessions, "daily-parent", "/work/daily-parent");
	const childPath = await writeSession(
		sessions,
		"daily-child",
		"/work/daily-child",
		"daily-parent",
	);
	const piStatePath = join(root, "pi-state.json");
	await writeFile(
		piStatePath,
		`${JSON.stringify(
			{
				revision: 1,
				commands: [],
				sessions: [
					snapshot("daily-parent", "/work/daily-parent", 1),
					snapshot("daily-child", "/work/daily-child", 2),
				],
			},
			null,
			2,
		)}\n`,
	);
	const workspaceStatePath = join(stateDirectory, "workspace-state.json");
	await writeFile(
		workspaceStatePath,
		`${JSON.stringify(
			{
				version: 1,
				selectedSessionId: null,
				settings: {density: "compact", nodeDetailLevel: "full", theme: "dark"},
				packageRegistrations: ["fixture-extension-ui-peer", "fixture-plain-pi"],
				extensionUI: [
					{
						scope: {packageName: "fixture-extension-ui-peer", sessionId: "session-peer"},
						statuses: [{key: "phase", text: "eş paket durumu"}],
						widgets: [{key: "plan", lines: ["peer below"], placement: "belowEditor"}],
					},
				],
			},
			null,
			2,
		)}\n`,
	);

	let server: Awaited<ReturnType<typeof startServer>> | undefined;
	const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
	const errors: Array<string> = [];
	try {
		server = await startServer(root, 0);
		const port = Number(new URL(server.url).port);
		const context = await browser.newContext({viewport: {width: 1_280, height: 800}});
		contexts.push(context);
		const page = await context.newPage();
		attachErrors(page, errors);
		let discoveryRequests = 0;
		page.on("request", (request) => {
			if (!request.url().endsWith("/fate") || request.method() !== "POST") return;
			const operations = request.postDataJSON()?.operations ?? [];
			if (operations.some(({name}: {name?: string}) => name === "discovery")) {
				discoveryRequests += 1;
			}
		});
		await page.goto(server.url);

		const parent = page.locator('[data-id="pi:daily-parent"]');
		const child = page.locator('[data-id="pi:daily-child"]');
		await expect(parent).toBeVisible();
		await expect(child).toBeVisible();
		await expect(page.locator('[data-id="fork:pi:daily-child"]')).toHaveCount(1);
		await expect(page.locator('[data-id="package:fixture-plain-pi:fixture.node"]')).toBeVisible();
		await expect(page.getByRole("region", {name: "Fixture paket paneli"})).toContainText(
			"fixture.panel sağlıklı",
		);
		await expect(page.getByText("eş paket durumu", {exact: true})).toHaveCount(1);
		await expect(page.getByText("peer below", {exact: true})).toHaveCount(1);
		await expect(page.locator(".detail-setting").getByText("Tam", {exact: true})).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(await page.locator("html").getAttribute("data-density")).toBe("compact");
		await selectNode(page, "pi:daily-child");
		await expect(child.locator(".session-node")).toHaveAttribute("data-selected", "true");
		await expect(page.locator("#chat-title")).toHaveText("daily-child");
		await expect(page.getByText("daily-child kalıcı konuşma", {exact: true})).toHaveCount(1);
		const prompt = "tek günlük sürücü istemi";
		const editor = page.getByRole("textbox", {name: "İstem"});
		await editor.fill(prompt);
		await editor.press("Enter");
		await expect(page.getByText("İleti pi tarafından onaylandı.")).toBeVisible();
		await expect(page.getByText(prompt, {exact: true})).toHaveCount(1);
		const thinking = page.getByRole("combobox", {name: "Düşünme düzeyi"});
		await thinking.selectOption("medium");
		await expect(
			page.getByText("Düşünme düzeyi değiştirme pi tarafından onaylandı."),
		).toBeVisible();
		await expect(thinking).toHaveValue("medium");
		await page.locator(".detail-setting").getByText("Meta", {exact: true}).click();
		await expect(page.locator('.session-node[data-detail-level="meta"]')).toHaveCount(2);

		const desktop = testInfo.outputPath("daily-driver-initial-desktop.png");
		await page.screenshot({path: desktop, fullPage: true});
		await testInfo.attach("daily-driver-initial-desktop", {
			path: desktop,
			contentType: "image/png",
		});

		const requestsBeforeReconnect = discoveryRequests;
		const stopping = stopServer(server.child);
		await expect(
			page.getByText("Bağlantı kesildi · yeniden bağlanıyor", {exact: true}),
		).toBeVisible();
		await stopping;
		server = await startServer(root, port);
		await expect(page.locator(".chat-pane").getByText("Canlı", {exact: true})).toBeVisible({
			timeout: 5_000,
		});
		await expect.poll(() => discoveryRequests).toBe(requestsBeforeReconnect + 1);
		await expect(page.getByText(prompt, {exact: true})).toHaveCount(1);
		await expect(page.getByText("Düşünme düzeyi değiştirme pi tarafından onaylandı.")).toHaveCount(
			1,
		);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByText("eş paket durumu", {exact: true})).toHaveCount(1);
		await expect(page.getByText("peer below", {exact: true})).toHaveCount(1);
		const persistedPi = JSON.parse(await readFile(piStatePath, "utf8"));
		expect(persistedPi.commands).toEqual([
			{command: "prompt", text: prompt},
			{command: "set_thinking", value: "medium"},
		]);

		await context.close();
		const coldContext = await browser.newContext({viewport: {width: 1_280, height: 800}});
		contexts.push(coldContext);
		const coldPage = await coldContext.newPage();
		attachErrors(coldPage, errors);
		await coldPage.goto(server.url);
		await expect(coldPage.locator('[data-id="pi:daily-parent"]')).toBeVisible();
		await expect(coldPage.locator('[data-id="pi:daily-child"]')).toBeVisible();
		await expect(coldPage.locator('[data-id="fork:pi:daily-child"]')).toHaveCount(1);
		await expect(coldPage.locator('.session-node[data-detail-level="full"]')).toHaveCount(2);
		expect(await coldPage.locator("html").getAttribute("data-density")).toBe("compact");
		await expect(coldPage.locator('[data-id="pi:daily-child"] .session-node')).toHaveAttribute(
			"data-selected",
			"true",
		);
		await expect(coldPage.locator("#chat-title")).toHaveText("daily-child");
		await expect(coldPage.getByText(prompt, {exact: true})).toHaveCount(1);
		await expect(
			coldPage.getByText("Düşünme düzeyi değiştirme pi tarafından onaylandı."),
		).toHaveCount(0);
		await expect(coldPage.getByRole("dialog")).toHaveCount(0);
		await expect(coldPage.getByText("eş paket durumu", {exact: true})).toHaveCount(1);
		await expect(coldPage.getByText("peer below", {exact: true})).toHaveCount(1);

		const desktopChat = coldPage.locator(".chat-pane");
		const desktopTranscript = coldPage.locator(".transcript");
		const desktopComposer = coldPage.locator(".composer-shell");
		const desktopExtension = coldPage.locator(".extension-ui");
		const [desktopChatBox, desktopTranscriptBox, desktopComposerBox, desktopExtensionBox] =
			await Promise.all([
				desktopChat.boundingBox(),
				desktopTranscript.boundingBox(),
				desktopComposer.boundingBox(),
				desktopExtension.boundingBox(),
			]);
		expect(desktopChatBox).not.toBeNull();
		expect(desktopTranscriptBox).not.toBeNull();
		expect(desktopComposerBox).not.toBeNull();
		expect(desktopExtensionBox).not.toBeNull();
		expect((desktopChatBox?.y ?? 0) + (desktopChatBox?.height ?? 0)).toBeLessThanOrEqual(
			desktopExtensionBox?.y ?? 0,
		);
		expect(
			(desktopTranscriptBox?.y ?? 0) + (desktopTranscriptBox?.height ?? 0),
		).toBeLessThanOrEqual(desktopExtensionBox?.y ?? 0);
		expect((desktopComposerBox?.y ?? 0) + (desktopComposerBox?.height ?? 0)).toBeLessThanOrEqual(
			desktopExtensionBox?.y ?? 0,
		);
		expect(desktopChatBox?.width).toBe(456);
		expect(desktopExtensionBox?.width).toBe(360);
		expect(await desktopTranscript.evaluate((element) => getComputedStyle(element).overflowY)).toBe(
			"auto",
		);
		const transcriptScroll = await desktopTranscript.evaluate((element) => {
			element.scrollTop = 0;
			const startsAtTop = element.scrollTop === 0;
			element.scrollTop = element.scrollHeight;
			return {
				startsAtTop,
				scrollTop: element.scrollTop,
				scrollHeight: element.scrollHeight,
				clientHeight: element.clientHeight,
			};
		});
		expect(transcriptScroll.startsAtTop).toBe(true);
		expect(transcriptScroll.scrollHeight).toBeGreaterThan(transcriptScroll.clientHeight);
		expect(transcriptScroll.scrollTop).toBeGreaterThan(0);
		const desktopEditor = coldPage.getByRole("textbox", {name: "İstem"});
		await desktopEditor.focus();
		await expect(desktopEditor).toBeFocused();
		await expect(
			coldPage.getByText("fixture-extension-ui-peer · session-peer").first(),
		).toBeVisible();
		await expect(coldPage.locator(".react-flow")).toBeVisible();
		await expect(coldPage.getByRole("button", {name: "Yakınlaştır"})).toBeEnabled();

		const coldDesktop = testInfo.outputPath("daily-driver-cold-desktop-a11y.png");
		await coldPage.screenshot({path: coldDesktop});
		await testInfo.attach("daily-driver-cold-desktop-a11y", {
			path: coldDesktop,
			contentType: "image/png",
		});

		await coldPage.setViewportSize({width: 390, height: 844});
		const mobileNavigation = coldPage.getByRole("navigation", {
			name: "Mobil çalışma alanı katmanları",
		});
		await expect(mobileNavigation).toBeVisible();
		await expect(coldPage.locator(".chat-pane")).toBeVisible();
		await expect(coldPage.locator("#canvas")).toBeHidden();
		await expect(coldPage.locator(".extension-ui")).toBeHidden();
		const chatBox = await coldPage.locator(".chat-pane").boundingBox();
		expect(chatBox).not.toBeNull();
		expect(chatBox?.x).toBeGreaterThanOrEqual(0);
		expect((chatBox?.x ?? 0) + (chatBox?.width ?? 0)).toBeLessThanOrEqual(390);
		expect((chatBox?.y ?? 0) + (chatBox?.height ?? 0)).toBeLessThanOrEqual(844);
		await expect(coldPage.getByRole("textbox", {name: "İstem"})).toBeVisible();
		expect(
			await coldPage
				.locator(".transcript")
				.evaluate((element) => getComputedStyle(element).overflowY),
		).toBe("auto");

		await coldPage.locator("#mobile-layer-canvas").focus();
		await coldPage.keyboard.press("Shift+Tab");
		expect(
			await coldPage.evaluate(
				() => document.activeElement?.closest('[data-mobile-panel="chat"]') !== null,
			),
		).toBe(true);
		await coldPage.keyboard.press("Escape");
		await expect(coldPage.locator("#mobile-layer-canvas")).toBeFocused();
		await expect(coldPage.locator("#canvas")).toBeVisible();
		await expect(coldPage.locator(".chat-pane")).toBeHidden();
		await expect(coldPage.getByRole("button", {name: "Sohbet", exact: true})).toBeEnabled();
		await expect(coldPage.locator('[data-id="pi:daily-child"] .session-node')).toHaveAttribute(
			"data-selected",
			"true",
		);
		await expect(coldPage.getByRole("button", {name: "Yakınlaştır"})).toBeEnabled();
		const controlsBox = await coldPage.locator(".canvas-controls").boundingBox();
		const packagePanelBox = await coldPage.locator(".package-panels").boundingBox();
		const contributionBox = await coldPage.locator(".contribution-status").boundingBox();
		const canvasStageBox = await coldPage.locator(".canvas-stage").boundingBox();
		const canvasLegendBox = await coldPage.locator(".canvas-legend").boundingBox();
		expect(controlsBox).not.toBeNull();
		expect(packagePanelBox).not.toBeNull();
		expect(contributionBox).not.toBeNull();
		expect(canvasStageBox).not.toBeNull();
		expect(canvasLegendBox).not.toBeNull();
		expect((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0)).toBeLessThanOrEqual(
			packagePanelBox?.y ?? 0,
		);
		expect((packagePanelBox?.y ?? 0) + (packagePanelBox?.height ?? 0)).toBeLessThanOrEqual(
			canvasLegendBox?.y ?? 0,
		);
		expect((contributionBox?.y ?? 0) + (contributionBox?.height ?? 0)).toBeLessThanOrEqual(
			canvasStageBox?.y ?? 0,
		);
		for (const control of await coldPage.locator(".canvas-controls button").all()) {
			const box = await control.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(36);
			expect(box?.width).toBeGreaterThanOrEqual(36);
		}

		const mobileCanvas = testInfo.outputPath("daily-driver-cold-mobile-canvas.png");
		await coldPage.screenshot({path: mobileCanvas});
		await testInfo.attach("daily-driver-cold-mobile-canvas", {
			path: mobileCanvas,
			contentType: "image/png",
		});

		await coldPage.getByRole("button", {name: "Extension UI", exact: true}).click();
		await expect(coldPage.locator(".extension-ui")).toBeVisible();
		await expect(coldPage.locator("#canvas")).toBeHidden();
		await expect(coldPage.locator(".chat-pane")).toBeHidden();
		await expect(coldPage.getByText("eş paket durumu", {exact: true})).toBeVisible();
		await expect(coldPage.getByText("peer below", {exact: true})).toBeVisible();
		await expect(
			coldPage.getByText("fixture-extension-ui-peer · session-peer").first(),
		).toBeVisible();
		expect(
			await coldPage
				.locator(".extension-ui")
				.evaluate((element) => getComputedStyle(element).overflowY),
		).toBe("auto");

		const mobileExtension = testInfo.outputPath("daily-driver-cold-mobile-extension.png");
		await coldPage.screenshot({path: mobileExtension});
		await testInfo.attach("daily-driver-cold-mobile-extension", {
			path: mobileExtension,
			contentType: "image/png",
		});

		await coldPage.getByRole("button", {name: "Sohbet", exact: true}).click();
		const mobileChatPane = coldPage.locator(".chat-pane");
		await expect(mobileChatPane).toBeVisible();
		await expect(coldPage.getByRole("textbox", {name: "İstem"})).toBeVisible();
		await mobileChatPane.evaluate(async (element) => {
			await Promise.all(element.getAnimations().map((animation) => animation.finished));
		});
		const mobileChat = testInfo.outputPath("daily-driver-cold-mobile-chat.png");
		await coldPage.screenshot({path: mobileChat});
		await testInfo.attach("daily-driver-cold-mobile-chat", {
			path: mobileChat,
			contentType: "image/png",
		});
		await coldPage.getByRole("button", {name: "Tuval", exact: true}).click();
		await expect(coldPage.locator("#canvas")).toBeVisible();
		await expect(coldPage.locator(".chat-pane")).toBeHidden();

		await stopServer(server.child);
		const persistedWorkspace = JSON.parse(await readFile(workspaceStatePath, "utf8"));
		await writeFile(
			workspaceStatePath,
			`${JSON.stringify({...persistedWorkspace, extensionUI: "secret-prompt-for-alice"}, null, 2)}\n`,
		);
		await writeFile(join(root, "child-unavailable"), "unavailable\n");
		await unlink(childPath);
		server = await startServer(root, port);

		const degradedContext = await browser.newContext({viewport: {width: 1_280, height: 800}});
		contexts.push(degradedContext);
		const degradedPage = await degradedContext.newPage();
		attachErrors(degradedPage, errors);
		await degradedPage.goto(server.url);
		await expect(degradedPage.locator('[data-id="pi:daily-parent"]')).toBeVisible();
		await expect(degradedPage.getByRole("heading", {name: "Geri yükleme durumu"})).toBeVisible();
		await expect(
			degradedPage.getByText("Önceki sohbet kullanılamıyor", {exact: true}),
		).toBeVisible();
		await expect(degradedPage.getByRole("list", {name: "Geri yükleme tanıları"})).toContainText(
			"Extension UI",
		);
		await expect(degradedPage.locator("body")).not.toContainText("secret-prompt-for-alice");
		await expect(degradedPage.locator('[data-id="pi:daily-parent"]')).toBeVisible();
		await expect(degradedPage.locator('[data-id="pi:daily-child"] .session-node')).toHaveAttribute(
			"data-selected",
			"false",
		);
		const focusedParent = degradedPage.locator('[data-id="pi:daily-parent"]');
		await expect(focusedParent).toBeFocused();
		await focusedParent.press("Enter");
		await expect(degradedPage.locator("#chat-title")).toHaveText("daily-parent");
		await expect(focusedParent.locator(".session-node")).toHaveAttribute("data-selected", "true");
		await expect(degradedPage.getByText("eş paket durumu", {exact: true})).toHaveCount(1);
		await expect(degradedPage.getByRole("dialog")).toHaveCount(0);
		await expect(degradedPage.locator(".react-flow")).toBeVisible();
		await expect(degradedPage.getByRole("button", {name: "Yakınlaştır"})).toBeEnabled();

		expect(parentPath).toContain("daily-parent");
		expect(errors).toEqual([]);
	} finally {
		await stopServer(server?.child);
		for (const context of contexts) await context.close().catch(() => undefined);
		await rm(root, {recursive: true, force: true});
	}
});
