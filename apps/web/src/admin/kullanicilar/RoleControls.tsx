/**
 * `RoleControls` — the per-row platform-role affordance for the kullanıcılar roster
 * (#3523, split from #3203). One toggle that grants/revokes the moderatör role via the
 * `Admin.over(platform)`-gated `user.setRole` mutation (#3522), which writes the
 * `moderates` relation tuple. The server is the sole authority: a non-admin call comes
 * back the invisible `Denied` and shows the no-authority line, minting nothing.
 *
 * The panel renders this only when BOTH the roster flag `PHOENIX_USER_ADMIN` (the panel's
 * `FlagGate`) and the role-assign dark-ship flag `PHOENIX_USER_ROLE_ASSIGN` (the roster's
 * per-column `useFlag`) are on — the client half of the two-gate ship-dark contract whose
 * worker half fails the invisible `Denied` (ADR 0083).
 *
 * After a successful assignment `onRoleChanged` re-reads the roster through the gated
 * view so the row's derived `role` cell reflects the new value (the `moderates` tuple is
 * re-joined server-side; a `RoleState` write does not update the `UserAdmin` entity in the
 * client store). Render decisions are DOM-free in `role-controls.ts` (unit-tested).
 *
 * a11y: the `Button` primitive carries the focus ring + the 36px hit-area floor from the
 * shared styles (`.kp-btn` now floors `min-height`/`min-width` at `--tap-min`, #3791); the
 * outcome is a `role="status" aria-live="polite"` text region (state as words, never
 * color); copy is lowercase Turkish.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {RoleState, UserAdminRole} from "../../../worker/features/fate/views";
import {Button} from "../../components/ui/Button";
import {codeOf} from "../../fate/wire";
import {nextRole, roleActionLabel, roleOutcomeMessage} from "./role-controls";

const RoleStateSelect = view<RoleState>()({
	id: true,
	role: true,
});

interface RoleControlsProps {
	readonly userId: string;
	// Named `platformRole`, not `role`, so the JSX prop doesn't collide with the ARIA `role`
	// attribute the a11y lint keys on (a custom-component `role=` string trips it, #3523).
	readonly platformRole: UserAdminRole;
	/** Re-read the roster through the gated view so the row's `role` cell reflects the write. */
	readonly onRoleChanged: () => void;
}

export function RoleControls({userId, platformRole, onRoleChanged}: RoleControlsProps) {
	const fate = useFateClient();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	async function onToggle() {
		if (busy) return;
		setBusy(true);
		setMessage("");
		try {
			const {result, error} = await fate.mutations.user.setRole({
				input: {userId, role: nextRole(platformRole)},
				view: RoleStateSelect,
			});
			setMessage(
				roleOutcomeMessage(error ? null : (result?.role ?? null), error ? codeOf(error) : null),
			);
			if (!error) onRoleChanged();
		} catch (caught) {
			setMessage(roleOutcomeMessage(null, codeOf(caught)));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="kp-role" data-testid={`kullanicilar-role-controls-${userId}`}>
			<Button
				variant="secondary"
				size="sm"
				onClick={onToggle}
				disabled={busy}
				data-testid={`role-toggle-${userId}`}
			>
				{roleActionLabel(platformRole, busy)}
			</Button>
			{message ? (
				<p
					className="kp-role__message"
					role="status"
					aria-live="polite"
					data-testid={`role-message-${userId}`}
				>
					{message}
				</p>
			) : null}
		</div>
	);
}
