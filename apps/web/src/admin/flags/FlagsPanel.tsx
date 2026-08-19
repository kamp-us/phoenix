import {useState} from "react";
import {Alert} from "../../components/ui/Alert";
import {Button} from "../../components/ui/Button";
import {DECLARED_FLAGS} from "../../flags/keys";
import "./FlagsPanel.css";
import {
	actionButtonLabel,
	applyOverride,
	defaultLabel,
	effectiveLabel,
	effectiveValue,
	type FlagOverrides,
	type OverrideState,
	overrideLabel,
	overrideOutcomeMessage,
	overrideStateOf,
	parseOverridesFromCookie,
	serializeOverrideCookie,
} from "./flag-overrides";

const TOGGLE_STATES: readonly OverrideState[] = ["on", "off", "clear"];

function readOverrides(): FlagOverrides {
	if (typeof document === "undefined") return {};
	return parseOverridesFromCookie(document.cookie);
}

export default function FlagsPanel() {
	const [overrides, setOverrides] = useState<FlagOverrides>(readOverrides);
	const [message, setMessage] = useState("");

	function toggle(key: string, state: OverrideState) {
		const next = applyOverride(overrides, {key, state});
		// biome-ignore lint/suspicious/noDocumentCookie: writing this cookie IS the feature (#2742) — the panel's sole job is to set phoenix_flag_overrides client-side; the worker (#2741) honors it. A single synchronous write needs no Cookie Store API.
		document.cookie = serializeOverrideCookie(next);
		setOverrides(next);
		setMessage(overrideOutcomeMessage({key, state}));
	}

	return (
		<section className="kp-flags" aria-label="özellik bayrakları" data-testid="flags-panel">
			<p className="kp-flags__intro">
				bayraklar yalnızca bu tarayıcıda geçersiz kılınır — flagship veya başka kullanıcılar
				etkilenmez.
			</p>
			<ul className="kp-flags__list">
				{DECLARED_FLAGS.map((flag) => {
					const current = overrideStateOf(overrides, flag.key);
					const effective = effectiveValue(flag.defaultValue, overrides, flag.key);
					return (
						<li key={flag.key} className="kp-flags__row" data-testid={`flag-row-${flag.key}`}>
							<fieldset className="kp-flags__group">
								<legend className="kp-flags__legend">
									<code className="kp-flags__key">{flag.key}</code>
								</legend>
								<div className="kp-flags__meta">
									<span className="kp-flags__default">{defaultLabel(flag.defaultValue)}</span>
									<span className="kp-flags__override" data-testid={`flag-override-${flag.key}`}>
										{overrideLabel(current)}
									</span>
									<span className="kp-flags__effective">{effectiveLabel(effective)}</span>
								</div>
								<div className="kp-flags__actions">
									{TOGGLE_STATES.map((state) => (
										<Button
											key={state}
											size="sm"
											pressed={current === state}
											onClick={() => toggle(flag.key, state)}
											data-testid={`flag-${state}-${flag.key}`}
										>
											{actionButtonLabel(state)}
										</Button>
									))}
								</div>
							</fieldset>
						</li>
					);
				})}
			</ul>
			{message ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-flags__message"
					aria-live="polite"
					data-testid="flags-message"
				>
					{message}
				</Alert>
			) : null}
		</section>
	);
}
