/**
 * The lifted form-submit envelope (#1421). Drives `useDraftSubmit.run` through its
 * four branches against a fake mutation, pinning the behavior the ~6 migrated sites
 * now share: a returned `{error}` maps through the registry, an `UNAUTHORIZED`
 * throw redirects to auth, any other throw falls to the surface `failureFallback`,
 * and a clean result calls `onSuccess` with the mutation result.
 */
import {act, renderHook} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {authRedirectPath} from "../lib/returnTo";
import {useDraftSubmit} from "./useDraftSubmit";

const {navigate} = vi.hoisted(() => ({navigate: vi.fn()}));
vi.mock("react-router", () => ({useNavigate: () => navigate}));

const OVERRIDES = {BODY_REQUIRED: "yorum boş olamaz"} as const;
const REDIRECT = () => "/pano/yeni";

function setup() {
	navigate.mockClear();
	return renderHook(() => useDraftSubmit({overrides: OVERRIDES, redirectPath: REDIRECT}));
}

describe("useDraftSubmit.run — the shared submit envelope", () => {
	it("maps a returned {error} to its registry message and skips onSuccess", async () => {
		const {result} = setup();
		const onSuccess = vi.fn();
		await act(async () => {
			await result.current.run(
				async () => ({error: {message: "raw", code: "BODY_REQUIRED"}}),
				"fallback",
				onSuccess,
			);
		});
		expect(result.current.error).toBe("yorum boş olamaz");
		expect(onSuccess).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("redirects to auth on an UNAUTHORIZED throw, setting no inline error", async () => {
		const {result} = setup();
		await act(async () => {
			await result.current.run(
				async () => {
					throw {code: "UNAUTHORIZED"};
				},
				"fallback",
				vi.fn(),
			);
		});
		expect(navigate).toHaveBeenCalledWith(authRedirectPath("/pano/yeni"));
		expect(result.current.error).toBeNull();
	});

	it("falls a non-UNAUTHORIZED throw back to the surface failureFallback", async () => {
		const {result} = setup();
		await act(async () => {
			await result.current.run(
				async () => {
					throw {code: "INTERNAL_SERVER_ERROR"};
				},
				"gönderi paylaşılamadı",
				vi.fn(),
			);
		});
		expect(result.current.error).toBe("gönderi paylaşılamadı");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("calls onSuccess with the mutation result on a clean call", async () => {
		const {result} = setup();
		const onSuccess = vi.fn();
		await act(async () => {
			await result.current.run(async () => ({result: {id: "p1"}}), "fallback", onSuccess);
		});
		expect(onSuccess).toHaveBeenCalledWith({id: "p1"});
		expect(result.current.error).toBeNull();
	});
});
