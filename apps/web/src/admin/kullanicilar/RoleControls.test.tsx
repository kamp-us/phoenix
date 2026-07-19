/**
 * `RoleControls` component contract (#3523) — the per-row role-assign affordance wires the
 * `Admin.over(platform)`-gated `user.setRole` mutation (#3522). Pins: the toggle label per
 * current role, that a click invokes `user.setRole` with the toggled role, that a success
 * re-reads the roster (`onRoleChanged`) and shows the outcome, and that the invisible
 * `Denied` (a non-admin / flag-off refusal) shows the no-authority line and re-reads nothing.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RoleControls} from "./RoleControls";

// Keep react-fate's real `view` (used at module load for `RoleStateSelect`); stub the client
// so no transport is built — `setRole` is the only mutation the affordance touches.
let setRoleResult: {result?: {role: string}; error?: unknown};
const setRoleCalls: {userId: string; role: string}[] = [];
vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useFateClient: () =>
			({
				mutations: {
					user: {
						setRole: async ({input}: {input: {userId: string; role: string}}) => {
							setRoleCalls.push(input);
							return setRoleResult;
						},
					},
				},
			}) as never,
	};
});

afterEach(() => {
	setRoleCalls.length = 0;
	vi.clearAllMocks();
});

describe("RoleControls (#3523)", () => {
	it("a üye row offers to grant moderatör and assigns the moderator role on click", async () => {
		setRoleResult = {result: {role: "moderator"}};
		const onRoleChanged = vi.fn();
		render(<RoleControls userId="u-1" platformRole="member" onRoleChanged={onRoleChanged} />);

		const toggle = screen.getByTestId("role-toggle-u-1");
		expect(toggle.textContent).toBe("moderatör yap");

		fireEvent.click(toggle);
		await waitFor(() => expect(setRoleCalls).toHaveLength(1));
		expect(setRoleCalls[0]).toEqual({userId: "u-1", role: "moderator"});
		await waitFor(() =>
			expect(screen.getByTestId("role-message-u-1").textContent).toBe(
				"kullanıcı moderatör yapıldı.",
			),
		);
		expect(onRoleChanged).toHaveBeenCalledOnce();
	});

	it("a moderatör row offers to revoke and assigns the member role on click", async () => {
		setRoleResult = {result: {role: "member"}};
		const onRoleChanged = vi.fn();
		render(<RoleControls userId="u-2" platformRole="moderator" onRoleChanged={onRoleChanged} />);

		const toggle = screen.getByTestId("role-toggle-u-2");
		expect(toggle.textContent).toBe("moderatörlüğü al");

		fireEvent.click(toggle);
		await waitFor(() => expect(setRoleCalls[0]).toEqual({userId: "u-2", role: "member"}));
		await waitFor(() =>
			expect(screen.getByTestId("role-message-u-2").textContent).toBe("moderatörlük kaldırıldı."),
		);
		expect(onRoleChanged).toHaveBeenCalledOnce();
	});

	it("an invisible Denied shows the no-authority line and re-reads nothing", async () => {
		setRoleResult = {error: {code: "UNAUTHORIZED"}};
		const onRoleChanged = vi.fn();
		render(<RoleControls userId="u-3" platformRole="member" onRoleChanged={onRoleChanged} />);

		fireEvent.click(screen.getByTestId("role-toggle-u-3"));
		await waitFor(() =>
			expect(screen.getByTestId("role-message-u-3").textContent).toBe("bu işlem için yetkin yok."),
		);
		expect(onRoleChanged).not.toHaveBeenCalled();
	});
});
