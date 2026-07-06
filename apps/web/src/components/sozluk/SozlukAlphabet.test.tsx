/**
 * The A–Z index ARIA contract (#2169, a11y pillar of epic #2168). The alphabet is
 * the sözlük letter index (`SozlukAlphabet`): populated letters are real
 * `/sozluk?harf=<l>` links, empty letters are inert. These pin the accessible
 * semantics an AT user relies on to tell a navigable letter from an empty one and
 * to hear which letter each control is — the muted-color populated/empty
 * distinction and the single-char label ambiguity are both invisible to a screen
 * reader without these attributes.
 */
import {render} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukAlphabet} from "./Sozluk";

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
		// populated letters are real links (an href), never inert spans
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
		// an inert span is not a link (no interactive role announced)
		expect(z.tagName.toLowerCase()).toBe("span");
		// the AT-only suffix spells the empty distinction the muted color conveys visually
		const hidden = z.querySelector(".kp-visually-hidden");
		expect(hidden?.textContent).toBe("(Z harfi, terim yok)");
		// its full accessible text is the visible glyph + the hidden suffix
		expect(z.textContent).toBe("z(Z harfi, terim yok)");
	});

	it("marks the active letter aria-current=page", () => {
		const {container} = renderAlphabet({value: "a"});
		const active = container.querySelector(".kp-sozluk-alphabet__letter.is-active");
		expect(active?.getAttribute("aria-current")).toBe("page");
		expect(active?.getAttribute("aria-label")).toBe("A harfi");
	});
});
