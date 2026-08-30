import {type ChildProcess, spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {expect, test} from "@playwright/test";

const harness = fileURLToPath(new URL("./tuval-server.mjs", import.meta.url));

const start = async (port: number, packages: ReadonlyArray<string>) => {
	const child = spawn(process.execPath, [harness, String(port), ...packages], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Tuval contribution server did not start")),
			10_000,
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			const match = /Tuval ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
			if (match?.[1] !== undefined) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) =>
			reject(new Error(`Tuval contribution server exited (${code}): ${stderr}`)),
		);
	});
	return {child, url};
};

const stop = async (child: ChildProcess) => {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

test("real Tuval server loads, isolates, reports, and unloads package canvas contributions", async ({
	page,
}, testInfo) => {
	const pageErrors: Array<string> = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const packagePaths = [
		"../fixtures/plain-pi",
		"../fixtures/duplicate-frontend",
		"../fixtures/frontend-version",
		"../fixtures/frontend-failure",
		"../fixtures/built-in-frontend",
		"../fixtures/invalid-contract",
		"../fixtures/missing-asset",
	];
	let server = await start(0, packagePaths);
	try {
		await page.goto(server.url);
		const custom = page.locator('[data-id="package:fixture-plain-pi:fixture.node"]');
		await expect(custom).toBeVisible();
		await expect(custom).toHaveAccessibleName(
			"fixture-plain-pi paketinden fixture.node özel düğümü",
		);
		await expect(custom.getByText("Paket tuvali")).toBeVisible();
		const customEdge = page.locator('[data-id="package:fixture-plain-pi:fixture.edge"]');
		await expect(customEdge).toHaveCount(1);
		await expect(customEdge.locator(".fixture-package-edge")).toBeVisible();
		await expect(page.getByRole("region", {name: "Fixture paket paneli"})).toContainText(
			"fixture.panel sağlıklı",
		);
		await page.locator("#tray-open-contributions").click();
		await expect(page.getByRole("list", {name: "Etkin paket katkıları"})).toContainText(
			"fixture-plain-pi",
		);
		const isolated = page.getByRole("status").filter({hasText: "Yalıtılan katkılar"});
		await expect(isolated).toContainText("duplicate-frontend");
		await expect(isolated).toContainText("frontend-version");
		await expect(isolated).toContainText("frontend-failure");
		await expect(isolated).toContainText("fixture-built-in-frontend");
		await expect(isolated).toContainText(
			"Katkı relationship yerleşik bir Tuval anahtarını değiştirmeye çalışıyor",
		);
		await expect(isolated).toContainText("invalid-contract");
		await expect(isolated).toContainText("missing-asset");
		await expect(page.locator(".react-flow")).toBeVisible();
		await page.getByRole("button", {name: "Yakınlaştır"}).click();
		await expect(page.getByRole("button", {name: "Oturumları yenile"})).toBeEnabled();
		const successScreenshot = testInfo.outputPath("package-contribution-success-and-isolation.png");
		await page.screenshot({path: successScreenshot, fullPage: true});
		await testInfo.attach("package-contribution-success-and-isolation", {
			path: successScreenshot,
			contentType: "image/png",
		});

		const port = Number(new URL(server.url).port);
		await stop(server.child);
		server = await start(port, []);
		await page.getByRole("button", {name: "Oturumları yenile"}).click();
		await expect(custom).toHaveCount(0);
		await expect(customEdge).toHaveCount(0);
		await expect(page.getByRole("region", {name: "Fixture paket paneli"})).toHaveCount(0);
		await expect(page.getByRole("status").filter({hasText: "fixture-plain-pi"})).toContainText(
			"kaldırıldı",
		);
		await expect(page.locator(".react-flow")).toBeVisible();
		const unloadScreenshot = testInfo.outputPath("package-contribution-unloaded.png");
		await page.screenshot({path: unloadScreenshot, fullPage: true});
		await testInfo.attach("package-contribution-unloaded", {
			path: unloadScreenshot,
			contentType: "image/png",
		});

		await stop(server.child);
		server = await start(port, packagePaths);
		await page.getByRole("button", {name: "Oturumları yenile"}).click();
		await expect(custom).toBeVisible();
		await expect(customEdge).toBeVisible();
		await expect(page.getByRole("region", {name: "Fixture paket paneli"})).toBeVisible();

		await stop(server.child);
		server = await start(0, ["../fixtures/render-throw"]);
		await page.goto(server.url);
		await page.locator("#tray-open-contributions").click();
		await expect(isolated).toContainText(
			"fixture-render-throwKatkı throw.node çizilirken durduruldu",
		);
		await expect(isolated).toContainText(
			"fixture-render-throwKatkı throw.edge çizilirken durduruldu",
		);
		await expect(isolated).toContainText(
			"fixture-render-throwKatkı throw.panel çizilirken durduruldu",
		);
		const builtInNode = page.locator(".react-flow__node-session").first();
		await expect(builtInNode).toHaveAttribute("tabindex", "0");
		await builtInNode.focus();
		await expect(builtInNode).toBeFocused();
		await page.getByRole("button", {name: "Yakınlaştır"}).click();
		const isolationScreenshot = testInfo.outputPath("package-contribution-edge-isolation.png");
		await page.screenshot({path: isolationScreenshot, fullPage: true});
		await testInfo.attach("package-contribution-edge-isolation", {
			path: isolationScreenshot,
			contentType: "image/png",
		});
		expect(pageErrors).toEqual([]);
	} finally {
		await stop(server.child);
	}
});

test("narrow Tuval contribution surfaces use one scroll flow without overlap", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({width: 390, height: 844});
	const server = await start(0, ["../fixtures/plain-pi", "../fixtures/built-in-frontend"]);
	try {
		await page.goto(server.url);
		const state = page.locator(".state-panel");
		const status = page.locator(".contribution-status");
		const stage = page.locator(".canvas-stage");
		const launch = page.locator(".session-launch");
		await page.locator("#tray-open-discovery").focus();
		await page.locator("#tray-open-discovery").press("Enter");
		await expect(state).toBeVisible();
		await expect(page.locator("[data-tray-panel]:not([hidden])")).toHaveCount(1);
		await page.locator("#tray-open-contributions").focus();
		await page.locator("#tray-open-contributions").press("Enter");
		await expect(state).toBeHidden();
		await expect(status).toBeVisible();
		await expect(page.locator("[data-tray-panel]:not([hidden])")).toHaveCount(1);
		await page.locator("#tray-open-sessions").focus();
		await page.locator("#tray-open-sessions").press("Enter");
		await expect(status).toBeHidden();
		await expect(launch).toBeVisible();
		await page.getByRole("button", {name: "Paneli kapat"}).click();
		await expect(stage).toBeVisible();
		const canvasControls = page.locator(".canvas-controls");
		const packagePanels = page.locator(".package-panels");
		const canvasLegend = page.locator(".canvas-legend");
		await expect(canvasControls).toBeVisible();
		await expect(packagePanels).toBeVisible();
		await expect(canvasLegend).toBeVisible();
		const [controlsBox, packagePanelsBox, legendBox] = await Promise.all([
			canvasControls.boundingBox(),
			packagePanels.boundingBox(),
			canvasLegend.boundingBox(),
		]);
		if (controlsBox === null || packagePanelsBox === null || legendBox === null) {
			throw new Error("Narrow canvas overlays must have measurable boxes");
		}
		const overlaps = (
			left: {x: number; y: number; width: number; height: number},
			right: {x: number; y: number; width: number; height: number},
		): boolean =>
			left.x < right.x + right.width &&
			left.x + left.width > right.x &&
			left.y < right.y + right.height &&
			left.y + left.height > right.y;
		expect(overlaps(packagePanelsBox, controlsBox)).toBe(false);
		expect(overlaps(packagePanelsBox, legendBox)).toBe(false);
		for (const button of await page.locator(".canvas-controls .kp-btn").all()) {
			const box = await button.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(36);
			expect(box?.width).toBeGreaterThanOrEqual(36);
		}
		const custom = page.locator('[data-id="package:fixture-plain-pi:fixture.node"]');
		const customEdge = page.locator('[data-id="package:fixture-plain-pi:fixture.edge"]');
		await custom.scrollIntoViewIfNeeded();
		await expect(custom).toBeVisible();
		await expect(customEdge).toBeVisible();
		await expect(page.getByRole("region", {name: "Fixture paket paneli"})).toBeVisible();
		const narrowScreenshot = testInfo.outputPath("package-contribution-narrow.png");
		await page.screenshot({path: narrowScreenshot});
		await testInfo.attach("package-contribution-narrow", {
			path: narrowScreenshot,
			contentType: "image/png",
		});
	} finally {
		await stop(server.child);
	}
});
