/**
 * The server is the sole authority here: the `user.setRole` mutation is `Admin.over(platform)`-
 * gated, so a non-admin call comes back the invisible `Denied` and shows the no-authority line,
 * minting nothing. The panel renders this only when both dark-ship flags are on (ADR 0083).
 */

import {Alert, Button} from "@kampus/design";
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {RoleState, UserAdminRole} from "../../../worker/features/fate/views";
import {codeOf} from "../../fate/wire";
import {type CatalogKey, useT} from "../../i18n";
import {nextRole, roleActionLabelKey, roleOutcomeKey} from "./role-controls";

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
	const t = useT();
	const fate = useFateClient();
	const [busy, setBusy] = useState(false);
	const [messageKey, setMessageKey] = useState<CatalogKey>();

	async function onToggle() {
		if (busy) return;
		setBusy(true);
		setMessageKey(undefined);
		try {
			const {result, error} = await fate.mutations.user.setRole({
				input: {userId, role: nextRole(platformRole)},
				view: RoleStateSelect,
			});
			setMessageKey(
				roleOutcomeKey(error ? null : (result?.role ?? null), error ? codeOf(error) : null),
			);
			if (!error) onRoleChanged();
		} catch (caught) {
			setMessageKey(roleOutcomeKey(null, codeOf(caught)));
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
				{t(roleActionLabelKey(platformRole, busy))}
			</Button>
			{messageKey ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-role__message"
					aria-live="polite"
					data-testid={`role-message-${userId}`}
				>
					{t(messageKey)}
				</Alert>
			) : null}
		</div>
	);
}
