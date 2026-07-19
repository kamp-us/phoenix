/**
 * Kullanıcılar role-assign gating (#3523) — the two-gate contract at the component tier:
 * the panel is behind `phoenix-user-admin`, and the per-row role affordance is behind its
 * own `phoenix-user-role-assign` dark-ship flag. Off ⇒ invisible, as a whole column (header
 * + cells), never an empty one. The read-view dark-ship (whole panel off) is proven
 * in-browser by `tests/e2e/31-kullanicilar-darkship.spec.ts`; this pins the role-column flag.
 */
import {render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import KullanicilarPanel from "./KullanicilarPanel";

// Keyed flag mock — both the panel `FlagGate` (`phoenix-user-admin`) and the role column's
// `useFlag` (`phoenix-user-role-assign`) read through this, so one map drives both gates.
let flags: Record<string, boolean>;
vi.mock("../../flags/useFlag", () => ({
	useFlag: (key: string) => ({value: flags[key] ?? false, loading: false}),
}));

// Keep react-fate's real `view`; stub the read hooks to yield exactly one roster row and the
// client so no transport is built. The row's derived `role` is what the affordance mutates.
const ROW = {
	id: "u-1",
	username: "anka",
	email: "anka@kamp.us",
	role: "member" as const,
	banned: false,
	tier: "çaylak",
	createdAt: 0,
};
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useRequest: () => ({"userAdmin.list": "conn-ref"}),
		useListView: () => [[{node: "row-ref-1"}], null, null],
		useView: () => ROW,
		useFateClient: () => ({mutations: {user: {setRole: vi.fn()}}}) as never,
	};
});

afterEach(() => vi.clearAllMocks());

describe("kullanıcılar role-assign gating (#3523)", () => {
	it("the whole roster is dark while phoenix-user-admin is off", () => {
		flags = {"phoenix-user-admin": false, "phoenix-user-role-assign": true};
		render(<KullanicilarPanel />);
		expect(screen.queryByTestId("kullanicilar-panel")).toBeNull();
		expect(screen.queryByTestId("role-toggle-u-1")).toBeNull();
	});

	it("the roster renders but the role column is invisible while phoenix-user-role-assign is off", () => {
		flags = {"phoenix-user-admin": true, "phoenix-user-role-assign": false};
		render(<KullanicilarPanel />);
		expect(screen.getByTestId("kullanicilar-table")).toBeTruthy();
		expect(screen.queryByTestId("role-toggle-u-1")).toBeNull();
		expect(screen.queryByText("rol işlemleri")).toBeNull();
	});

	it("the role column appears once both flags are on", () => {
		flags = {"phoenix-user-admin": true, "phoenix-user-role-assign": true};
		render(<KullanicilarPanel />);
		expect(screen.getByTestId("role-toggle-u-1")).toBeTruthy();
		expect(screen.getByText("rol işlemleri")).toBeTruthy();
	});
});
