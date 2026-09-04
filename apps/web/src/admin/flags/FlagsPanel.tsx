import {Alert, Button} from "@kampus/design";
import {useState} from "react";
import {DECLARED_FLAGS} from "../../flags/keys";
import {type CatalogKey, useT} from "../../i18n";
import "./FlagsPanel.css";
import {
	actionButtonLabelKey,
	applyOverride,
	defaultLabelKey,
	effectiveLabelKey,
	effectiveValue,
	type FlagOverrides,
	type OverrideState,
	overrideLabelKey,
	overrideOutcomeKey,
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
	const t = useT();
	const [overrides, setOverrides] = useState<FlagOverrides>(readOverrides);
	const [outcome, setOutcome] = useState<{key: string; messageKey: CatalogKey}>();

	function toggle(key: string, state: OverrideState) {
		const next = applyOverride(overrides, {key, state});
		// biome-ignore lint/suspicious/noDocumentCookie: writing this cookie IS the feature (#2742) — the panel's sole job is to set phoenix_flag_overrides client-side; the worker (#2741) honors it. A single synchronous write needs no Cookie Store API.
		document.cookie = serializeOverrideCookie(next);
		setOverrides(next);
		setOutcome({key, messageKey: overrideOutcomeKey(state)});
	}

	return (
		<section className="kp-flags" aria-label={t("admin.flags.label")} data-testid="flags-panel">
			<p className="kp-flags__intro">{t("admin.flags.intro")}</p>
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
									<span className="kp-flags__default">{t(defaultLabelKey(flag.defaultValue))}</span>
									<span className="kp-flags__override" data-testid={`flag-override-${flag.key}`}>
										{t(overrideLabelKey(current))}
									</span>
									<span className="kp-flags__effective">{t(effectiveLabelKey(effective))}</span>
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
											{t(actionButtonLabelKey(state))}
										</Button>
									))}
								</div>
							</fieldset>
						</li>
					);
				})}
			</ul>
			{outcome ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-flags__message"
					aria-live="polite"
					data-testid="flags-message"
				>
					{t(outcome.messageKey, {key: outcome.key})}
				</Alert>
			) : null}
		</section>
	);
}
