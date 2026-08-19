import {renderHook, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient, view} from "react-fate";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {type ImperativeViewClient, useImperativeView} from "./useImperativeView";

const TestView = view<{__typename: "TestEntity"; id: string; name: string}>()({
	id: true,
	name: true,
});

const DATA = {__typename: "TestEntity", id: "1", name: "neo"} as const;

// `useFateClient` reads the client off `<FateClient>`'s context — the provider is a
// plain context, so a stubbed `{request, readView}` is all the hook needs.
function makeWrapper(client: ImperativeViewClient) {
	return function wrapper({children}: {children: ReactNode}) {
		return <FateClient client={client as never}>{children}</FateClient>;
	};
}

describe("useImperativeView — the hook over its React interface", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stays idle and never touches the wire while disabled", async () => {
		const request = vi.fn();
		const readView = vi.fn();
		const {result} = renderHook(() => useImperativeView("test", TestView, {enabled: false}), {
			wrapper: makeWrapper({request, readView}),
		});
		await waitFor(() => expect(result.current.state.status).toBe("idle"));
		expect(request).not.toHaveBeenCalled();
	});

	it("drives the mount read to an ok state carrying the cast-surfaced data", async () => {
		const request = vi.fn().mockResolvedValue({test: "ref-1"});
		const readView = vi.fn().mockResolvedValue({data: DATA, coverage: []});
		const {result} = renderHook(() => useImperativeView("test", TestView, {enabled: true}), {
			wrapper: makeWrapper({request, readView}),
		});
		await waitFor(() => expect(result.current.state.status).toBe("ok"));
		expect(result.current.state).toEqual({status: "ok", data: DATA});
		expect(request).toHaveBeenCalledWith({test: {view: TestView}});
	});

	it("reports error when the read throws", async () => {
		const request = vi.fn().mockRejectedValue(new Error("boom"));
		const readView = vi.fn();
		const {result} = renderHook(() => useImperativeView("test", TestView, {enabled: true}), {
			wrapper: makeWrapper({request, readView}),
		});
		await waitFor(() => expect(result.current.state.status).toBe("error"));
	});

	it("re-reads on demand through refetch", async () => {
		const request = vi.fn().mockResolvedValue({test: "ref-1"});
		const readView = vi.fn().mockResolvedValue({data: DATA, coverage: []});
		const {result} = renderHook(() => useImperativeView("test", TestView, {enabled: true}), {
			wrapper: makeWrapper({request, readView}),
		});
		await waitFor(() => expect(result.current.state.status).toBe("ok"));
		await result.current.refetch();
		expect(request).toHaveBeenCalledTimes(2);
	});
});
