import {useId} from "react";
import {Input} from "../../components/ui/Form";
import {NumberInput} from "../../components/ui/NumberInput";
import {Switch} from "../../components/ui/Switch";
import {ToggleGroup} from "../../components/ui/ToggleGroup";
import type {AnyKnob, AnyKnobSchema, KnobValue, KnobValues} from "./knob";
import "./PropKnobs.css";

const styles = {
	root: "kp-knobs",
	empty: "kp-knobs__empty",
	row: "kp-knobs__row",
	label: "kp-knobs__label",
};

export interface PropKnobsProps {
	readonly schema: AnyKnobSchema;
	readonly values: KnobValues;
	readonly onChange: (key: string, value: KnobValue) => void;
}

export function PropKnobs({schema, values, onChange}: PropKnobsProps) {
	const entries = Object.entries(schema);
	if (entries.length === 0) {
		return (
			<p className={styles.empty} aria-live="polite">
				This exhibit has no adjustable props.
			</p>
		);
	}
	return (
		<div className={styles.root}>
			{entries.map(([key, knob]) => (
				<KnobRow
					key={key}
					name={key}
					knob={knob}
					value={values[key] ?? knob.default}
					onChange={(value) => onChange(key, value)}
				/>
			))}
		</div>
	);
}

function KnobRow({
	name,
	knob,
	value,
	onChange,
}: {
	name: string;
	knob: AnyKnob;
	value: KnobValue;
	onChange: (value: KnobValue) => void;
}) {
	const labelId = useId();
	const text = knob.label ?? name;
	return (
		<div className={styles.row}>
			<span id={labelId} className={styles.label}>
				{text}
			</span>
			<KnobControl name={name} knob={knob} value={value} labelId={labelId} onChange={onChange} />
		</div>
	);
}

function KnobControl({
	name,
	knob,
	value,
	labelId,
	onChange,
}: {
	name: string;
	knob: AnyKnob;
	value: KnobValue;
	labelId: string;
	onChange: (value: KnobValue) => void;
}) {
	switch (knob.kind) {
		case "string":
			return (
				<Input
					aria-labelledby={labelId}
					data-knob={name}
					placeholder={knob.placeholder}
					value={String(value)}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "number":
			return (
				<div className="kp-knobs__control" data-knob={name}>
					<NumberInput
						label={<span className="kp-visually-hidden">{knob.label ?? name}</span>}
						min={knob.min}
						max={knob.max}
						step={knob.step}
						value={String(value)}
						onValueChange={(_next, valueAsNumber) => onChange(valueAsNumber)}
					/>
				</div>
			);
		case "boolean":
			return (
				<fieldset className="kp-knobs__control" data-knob={name} aria-labelledby={labelId}>
					<Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)}>
						<span className="kp-visually-hidden">{name}</span>
					</Switch>
				</fieldset>
			);
		case "enum":
			return (
				<EnumControl name={name} knob={knob} value={value} labelId={labelId} onChange={onChange} />
			);
	}
}

function EnumControl({
	name,
	knob,
	value,
	labelId,
	onChange,
}: {
	name: string;
	knob: Extract<AnyKnob, {kind: "enum"}>;
	value: KnobValue;
	labelId: string;
	onChange: (value: KnobValue) => void;
}) {
	// Manti ToggleGroup keys on `string` values, so options are stringified at the control
	// boundary and mapped back to their real (possibly non-string) knob value on change.
	const asKey = (v: KnobValue) => String(v);
	return (
		<fieldset className="kp-knobs__control" data-knob={name} aria-labelledby={labelId}>
			<ToggleGroup
				variant="primary"
				className="kp-toggle-group kp-toggle-group--segmented"
				value={[asKey(value)]}
				onValueChange={(next) => {
					// Single-select semantics over a multi-select group: the last-pressed key wins;
					// deselecting the active item (empty array) keeps the current value.
					const key = next.length > 0 ? next[next.length - 1] : asKey(value);
					const option = knob.options.find((o) => asKey(o.value) === key);
					if (option) onChange(option.value);
				}}
				items={knob.options.map((option) => ({
					value: asKey(option.value),
					label: option.label ?? String(option.value),
				}))}
			/>
		</fieldset>
	);
}
