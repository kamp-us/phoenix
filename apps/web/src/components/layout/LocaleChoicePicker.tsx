import {LOCALE_LABELS, LOCALES, type Locale} from "../../i18n";
import {ToggleGroup} from "../ui/ToggleGroup";
import "./LocaleChoicePicker.css";

/**
 * The two-way `dil` control, built as the same segmented `ToggleGroup` the tema picker uses so
 * the two settings rows in the account popover read as one family (#7527).
 *
 * The labels are endonyms (`Türkçe` / `English`) rather than catalog strings: a language names
 * itself in every interface, so translating them would make the option you cannot currently read
 * the one you have to read to switch.
 */
export function LocaleChoicePicker({
	locale,
	onChange,
	testId,
	className = "",
}: {
	locale: Locale;
	onChange: (locale: Locale) => void;
	testId?: string;
	className?: string;
}) {
	return (
		<div className={`kp-locale-picker ${className}`.trim()} data-testid={testId}>
			<ToggleGroup
				variant="primary"
				value={[locale]}
				// Radio semantics on a Toggle track: a click on the active option would deselect
				// it to an empty value, so drop the empty case — a reader always has a locale.
				onValueChange={(v) => {
					const picked = LOCALES.find((candidate) => candidate === v[0]);
					if (picked) onChange(picked);
				}}
				className="kp-toggle-group kp-toggle-group--segmented"
				items={LOCALES.map((candidate) => ({
					value: candidate,
					label: LOCALE_LABELS[candidate],
				}))}
			/>
		</div>
	);
}
