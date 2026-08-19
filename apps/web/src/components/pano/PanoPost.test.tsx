/**
 * Regression proof for #2215: a static aria-label on the vote button leaves screen
 * reader users with stale toggle feedback.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {VoteControl} from "./PanoPost";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PANO_POST_CSS = readSource("./PanoPost.css");

describe("VoteControl — vote button accessible name toggles with state (#2215)", () => {
	it('reads "Yukarı oy" when the vote is not active', () => {
		const {getByTestId} = render(<VoteControl count={3} pressed={false} testIdSuffix="p1" />);
		expect(getByTestId("post-vote-p1").getAttribute("aria-label")).toBe("Yukarı oy");
	});

	it('reads "Oyunu geri al" (the undo affordance) when the vote is active', () => {
		const {getByTestId} = render(<VoteControl count={4} pressed={true} testIdSuffix="p1" />);
		expect(getByTestId("post-vote-p1").getAttribute("aria-label")).toBe("Oyunu geri al");
	});

	it("keeps the own-post affordance visible but disabled", () => {
		const {getByTestId} = render(<VoteControl count={4} own testIdSuffix="p1" />);
		const button = getByTestId("post-vote-p1");
		expect(button.getAttribute("aria-label")).toBe("Kendi gönderine oy veremezsin");
		expect(button.hasAttribute("disabled")).toBe(true);
	});

	it("keeps the save action free of link-style underline on hover", () => {
		expect(PANO_POST_CSS).toMatch(/\.kp-pano-post__save:hover\s*\{[^}]*text-decoration:\s*none/s);
	});
});
