/**
 * This pins the role-column flag only. The whole-panel dark-ship is proven in-browser by
 * `tests/e2e/31-kullanicilar-darkship.spec.ts`.
 */
import {render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import KullanicilarPanel from "./KullanicilarPanel";

// Keyed by flag so one map drives both gates: the panel `FlagGate` and the column's `useFlag`.
let flags: Record<string, boolean>;
vi.mock("../../flags/useFlag", () => ({
	useFlag: (key: string) => ({value: flags[key] ?? false, loading: false}),
}));

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
