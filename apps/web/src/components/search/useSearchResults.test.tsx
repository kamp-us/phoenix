/**
 * The palette's read seam: the debounce, the stale-answer guard and the scope narrowing.
 * The fate client is a stub — what is under test is which reads are issued, and which
 * answers are allowed to land.
 */
import {act, render} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PANO_SIGIL, SOZLUK_SIGIL, useSearchResults} from "./useSearchResults";

/** Only the parts of a fate request this file asserts on. */
type IssuedRequest = Record<string, {args?: {query?: string}}>;

const requests: IssuedRequest[] = [];
let resolvers: Array<(value: unknown) => void> = [];

const fate = {
	request: (request: IssuedRequest) => {
		requests.push(request);
		return new Promise((resolve) => resolvers.push(resolve));
	},
	// Every node reads back as its own ref — the connection shape is what matters here.
	readView: (_view: unknown, ref: unknown) => Promise.resolve({data: ref}),
};

vi.mock("../../fate/useImperativeView", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../fate/useImperativeView")>();
	return {...original, useFateClientWhenEnabled: () => fate};
});

let seen: ReturnType<typeof useSearchResults>;

function Probe({query, scope}: {query: string; scope?: string}) {
	seen = useSearchResults(query, scope);
	return null;
}

const settle = async () => {
	await act(async () => {
		await Promise.resolve();
	});
};

describe("useSearchResults", () => {
	beforeEach(() => {
		requests.length = 0;
		resolvers = [];
		vi.useFakeTimers({shouldAdvanceTime: true});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("issues nothing below the backend's 2-char minimum (a dead read is not a search)", async () => {
		render(<Probe query="a" />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(requests).toHaveLength(0);
		expect(seen.status).toBe("idle");
	});

	it("waits out a typing burst — one read for the settled query, not one per keystroke", async () => {
		const {rerender} = render(<Probe query="ef" />);
		rerender(<Probe query="eff" />);
		rerender(<Probe query="effe" />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.searchTerms?.args?.query).toBe("effe");
	});

	it("reads BOTH surfaces with no scope, and only the scoped one with a sigil", async () => {
		const {rerender} = render(<Probe query="react" />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(Object.keys(requests[0] ?? {}).sort()).toEqual(["searchPosts", "searchTerms"]);

		rerender(<Probe query="react" scope={SOZLUK_SIGIL} />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(Object.keys(requests[1] ?? {})).toEqual(["searchTerms"]);

		rerender(<Probe query="react" scope={PANO_SIGIL} />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(Object.keys(requests[2] ?? {})).toEqual(["searchPosts"]);
	});

	it("drops a slower earlier answer — the latest query owns the list", async () => {
		const {rerender} = render(<Probe query="elma" />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		rerender(<Probe query="armut" />);
		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(resolvers).toHaveLength(2);

		// The SECOND query answers first, then the first query's stale answer arrives.
		await act(async () => {
			resolvers[1]?.({searchTerms: {items: [{node: {id: "armut"}}]}, searchPosts: {items: []}});
		});
		await settle();
		await act(async () => {
			resolvers[0]?.({searchTerms: {items: [{node: {id: "elma"}}]}, searchPosts: {items: []}});
		});
		await settle();

		expect(seen.status).toBe("ok");
		expect(seen.status === "ok" ? seen.terms.map((term) => term.id) : []).toEqual(["armut"]);
	});
});
