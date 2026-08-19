import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukAlphabet} from "./Sozluk";

const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SOZLUK_CSS = readSource("./Sozluk.css");

function renderAlphabet(props: Parameters<typeof SozlukAlphabet>[0]) {
	return render(
		<MemoryRouter>
			<SozlukAlphabet {...props} />
		</MemoryRouter>,
	);
}

describe("SozlukAlphabet — A–Z index ARIA (#2169)", () => {
	it("names the index as a landmark (nav[aria-label])", () => {
		const {container} = renderAlphabet({});
		const nav = container.querySelector("nav.kp-sozluk-alphabet");
		expect(nav?.getAttribute("aria-label")).toBe("Harf");
	});

	it("gives each populated letter a spelled-out accessible name (not a bare char)", () => {
		const {container} = renderAlphabet({});
		const a = container.querySelector("a.kp-sozluk-alphabet__letter");
		expect(a?.getAttribute("aria-label")).toBe("A harfi");
		expect(a?.tagName.toLowerCase()).toBe("a");
	});

	it("uppercases the letter name in Turkish locale (i → İ, not I)", () => {
		const {container} = renderAlphabet({});
		const labels = Array.from(container.querySelectorAll(".kp-sozluk-alphabet__letter")).map((el) =>
			el.getAttribute("aria-label"),
		);
		expect(labels).toContain("İ harfi"); // Turkish dotted-capital, not the ASCII "I harfi"
	});

	it("renders empty letters as inert spans (not links) with a visually-hidden 'terim yok' suffix", () => {
		const {container} = renderAlphabet({emptyLetters: ["z"]});
		const spans = container.querySelectorAll("span.kp-sozluk-alphabet__letter.is-empty");
		expect(spans).toHaveLength(1);
		const z = spans[0] as HTMLElement;
		expect(z.tagName.toLowerCase()).toBe("span");
		const hidden = z.querySelector(".kp-visually-hidden");
		expect(hidden?.textContent).toBe("(Z harfi, terim yok)");
		expect(z.textContent).toBe("z(Z harfi, terim yok)");
	});

	it("marks the active letter aria-current=page", () => {
		const {container} = renderAlphabet({value: "a"});
		const active = container.querySelector(".kp-sozluk-alphabet__letter.is-active");
		expect(active?.getAttribute("aria-current")).toBe("page");
		expect(active?.getAttribute("aria-label")).toBe("A harfi");
	});

	it("centers the alphabet inside Subnav without duplicate padding or divider", () => {
		expect(SOZLUK_CSS).toMatch(
			/\.kp-subnav__filters\s+\.kp-sozluk-alphabet\s*\{[^}]*align-items:\s*center[^}]*height:\s*100%[^}]*padding-block:\s*0[^}]*border-bottom:\s*0/s,
		);
		expect(SOZLUK_CSS).toMatch(/\.kp-sozluk-alphabet__letter\s*\{[^}]*line-height:\s*1/s);
	});
});
