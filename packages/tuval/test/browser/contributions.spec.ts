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
		"../fixtures/render-throw",
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
		await expect(page.getByRole("list", {name: "Etkin paket katkıları"})).toContainText(
			"fixture-plain-pi",
		);
		const isolated = page.getByRole("status").filter({hasText: "Yalıtılan katkılar"});
		await expect(isolated).toContainText("duplicate-frontend");
		await expect(isolated).toContainText("frontend-version");
		await expect(isolated).toContainText("frontend-failure");
		await expect(isolated).toContainText("invalid-contract");
		await expect(isolated).toContainText("missing-asset");
		await expect(page.locator(".react-flow")).toBeVisible();
		await expect(
			page.getByRole("status").filter({
				hasText: "fixture-render-throw paketi: Katkı throw.node çizilirken durduruldu",
			}),
		).toHaveAttribute("data-package", "fixture-render-throw");
		await expect(
			page.getByRole("status").filter({
				hasText: "fixture-render-throw paketi: Katkı throw.panel çizilirken durduruldu",
			}),
		).toHaveAttribute("data-package", "fixture-render-throw");
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
		await expect(page.locator('[data-package="fixture-render-throw"]')).toHaveCount(0);
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
		expect(pageErrors).toEqual([]);
	} finally {
		await stop(server.child);
	}
});
