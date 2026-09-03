/**
 * The "çaylak katkılarını yerinde göster" control (#6426, epic #4306) — the only surface
 * that flips the yazar opt-in of #6422.
 *
 * Split in two on purpose: {@link CaylakVisibilitySetting} owns the fate read, and
 * {@link CaylakVisibilityToggle} owns the flip. The toggle takes the stored value as a prop,
 * so its whole contract — the resting off state, the optimistic flip, and the revert-with-a-
 * message on a rejected write — is exercisable without a transport.
 *
 * A rejected write reverts the switch AND says so. Reverting silently would leave the yazar
 * looking at an off switch with no reason, which reads as "the setting doesn't work" rather
 * than "that didn't save". Phoenix wire codes are boundary-class, so a rejected mutation can
 * either return `{error}` or throw (`.patterns/fate-mutations-client.md`) — both branches
 * land in the same revert.
 */
import {useState} from "react";
import {useFateClient, useRequest, useView, view} from "react-fate";
import type {CaylakVisibilityPreference} from "../../../worker/features/fate/views";
import {useT} from "../../i18n";
import {Alert} from "../ui/Alert";
import {Switch} from "../ui/Switch";
import "./CaylakVisibilityToggle.css";

const PreferenceView = view<CaylakVisibilityPreference>()({
	id: true,
	optedIn: true,
	optedInAt: true,
});

/** Reads the viewer's own preference and hands its value to the control. */
export function CaylakVisibilitySetting() {
	const result = useRequest({"caylakVisibility.mine": {view: PreferenceView}});
	const preference = useView(PreferenceView, result["caylakVisibility.mine"]);
	// Off is the default AND the resting state: an account with nothing stored reads
	// `optedIn: false` from the server, and an absent record reads the same here.
	return <CaylakVisibilityToggle optedIn={preference?.optedIn ?? false} />;
}

export function CaylakVisibilityToggle({optedIn}: {readonly optedIn: boolean}) {
	const fate = useFateClient();
	const t = useT();
	const [checked, setChecked] = useState(optedIn);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);

	async function onCheckedChange(next: boolean) {
		if (saving) return;
		const previous = checked;
		setChecked(next);
		setSaving(true);
		setFailed(false);
		try {
			const {error} = next
				? await fate.mutations.caylakVisibility.optIn({input: {}, view: PreferenceView})
				: await fate.mutations.caylakVisibility.optOut({input: {}, view: PreferenceView});
			if (error) {
				setChecked(previous);
				setFailed(true);
			}
		} catch {
			setChecked(previous);
			setFailed(true);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="kp-caylak-visibility-toggle" data-testid="caylak-visibility-toggle">
			<Switch
				checked={checked}
				disabled={saving}
				onCheckedChange={onCheckedChange}
				rootProps={{"data-testid": "caylak-visibility-switch"}}
				inputProps={{"data-testid": "caylak-visibility-switch-input"}}
			>
				{t("caylakVisibility.toggle.label")}
			</Switch>
			<p className="kp-caylak-visibility-toggle__hint">{t("caylakVisibility.toggle.hint")}</p>
			{failed ? (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-caylak-visibility-toggle__error"
					data-testid="caylak-visibility-error"
				>
					{t("caylakVisibility.toggle.error")}
				</Alert>
			) : null}
		</div>
	);
}
