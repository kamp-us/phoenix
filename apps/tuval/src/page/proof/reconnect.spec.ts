/**
 * The page recovering from a dropped socket, in a real browser (#8004).
 *
 * jsdom cannot hold this claim: the unit tier drives the lifecycle over a scripted link
 * (`../connection.unit.test.ts`), which proves the arithmetic and the scopes and nothing about a
 * socket. Here the page is the shipped `../main.tsx`, the socket is real, and the drop is a real
 * outage taken off the wire and put back (`./relay.ts`) while the kernel and its Pi session keep
 * running.
 *
 * **Neither test re-attaches anything.** The only acts a spec takes are cut, restore and one prompt
 * sent to the kernel; every re-attach on the page is the page's own, which is the claim.
 *
 * The two tests are the same journey over two pages that differ in one value — the recovery the
 * page boots with (`../connection.ts`'s `defaultRecovery` against `noRecovery`). The second one is
 * what makes the first falsifiable: with the lifecycle off, the fresh output never arrives.
 *
 * Each test drives its own harness, because one boot holds two turns and a test spends both
 * (`./names.ts`).
 */

import {expect, test} from "@playwright/test";
import {PROMPT_2, REPLY_1, REPLY_2} from "../../pi/proof/names.ts";
import {CONTROL_PORTS} from "./names.ts";

interface ProofState {
	readonly pageUrl: string;
	readonly noRecoveryUrl: string;
	readonly processId: string;
	readonly replies: number;
}

/** The banner's accessible name. The desk has live regions of its own; this picks out the one. */
const BANNER = {name: "Connection"} as const;

const controls = (port: number) => `http://127.0.0.1:${port}`;

test.describe("the browser page across a dropped socket", () => {
	test("recovers on its own and shows fresh process output, with no reload", async ({
		page,
		request,
	}) => {
		const control = controls(CONTROL_PORTS.recovering);
		const before = (await (await request.get(`${control}/state`)).json()) as ProofState;
		expect(before.replies, "the harness chatted its one setup turn").toBe(1);

		await page.goto(before.pageUrl);
		await expect(page.getByText(REPLY_1)).toBeVisible();
		// A reload would clear this, and a reload is the manual recovery this ticket removes. It goes
		// on the document rather than on a global because a `data-` attribute is typed all the way
		// through (`DOMStringMap`) and needs no assertion to read back.
		await page.evaluate(() => {
			document.documentElement.dataset.reconnectProof = "kept";
		});

		await request.get(`${control}/cut`);
		await expect(page.getByRole("status", BANNER)).toContainText("Reconnecting…");
		// The retained desk stays readable through the gap; that is what the banner is qualifying.
		await expect(page.getByText(REPLY_1)).toBeVisible();

		await request.get(`${control}/restore`);
		await expect(page.getByRole("status", BANNER)).toHaveCount(0);

		await request.get(`${control}/prompt?key=after-drop&text=${encodeURIComponent(PROMPT_2)}`);
		await expect(page.getByText(REPLY_2)).toBeVisible();

		const after = (await (await request.get(`${control}/state`)).json()) as ProofState;
		expect(after.replies).toBe(before.replies + 1);
		expect(after.processId, "recovery replaced the socket, not the process").toBe(before.processId);
		expect(
			await page.evaluate(() => document.documentElement.dataset.reconnectProof),
			"the page never reloaded",
		).toBe("kept");
	});

	test("shows nothing fresh with the page's recovery off — the same journey, falsified", async ({
		page,
		request,
	}) => {
		const control = controls(CONTROL_PORTS.refusing);
		const before = (await (await request.get(`${control}/state`)).json()) as ProofState;
		expect(before.replies).toBe(1);

		await page.goto(before.noRecoveryUrl);
		await expect(page.getByText(REPLY_1)).toBeVisible();

		await request.get(`${control}/cut`);
		await expect(page.getByRole("alert", BANNER)).toContainText("Disconnected.");
		await expect(page.getByText(REPLY_1)).toBeVisible();

		await request.get(`${control}/restore`);
		await request.get(`${control}/prompt?key=after-drop&text=${encodeURIComponent(PROMPT_2)}`);

		// The kernel produced the reply and kept the process; the page is the only thing that missed
		// it, and that is the whole difference between this arm and the one above.
		const after = (await (await request.get(`${control}/state`)).json()) as ProofState;
		expect(after.replies).toBe(before.replies + 1);
		expect(after.processId).toBe(before.processId);
		await expect(page.getByText(REPLY_2)).toHaveCount(0);
		await expect(page.getByRole("alert", BANNER)).toBeVisible();
	});
});
