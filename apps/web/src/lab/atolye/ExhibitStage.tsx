import {Surface} from "@kampus/design";
import type {AnyExhibit} from "./exhibit";
import {PropKnobs} from "./PropKnobs";
import "./ExhibitStage.css";
import {type KnobState, useKnobs} from "./useKnobs";

const styles = {
	root: "kp-exhibit-stage",
	stage: "kp-exhibit-stage__stage",
	panel: "kp-exhibit-stage__panel",
	panelTitle: "kp-exhibit-stage__panel-title",
};

export interface ExhibitStageProps {
	readonly exhibit: AnyExhibit;
	readonly knobs?: KnobState;
}

export function ExhibitStage({exhibit, knobs}: ExhibitStageProps) {
	// The uncontrolled fallback is always instantiated (hooks run unconditionally) but goes
	// unused when a controlled `knobs` state is supplied.
	const internal = useKnobs(exhibit.knobs);
	const {values, setKnob} = knobs ?? internal;
	const Component = exhibit.component;
	const props = {...exhibit.fixedProps, ...values};
	return (
		<div className={styles.root}>
			<Surface
				tone="sunken"
				radius="md"
				border
				padding="lg"
				className={styles.stage}
				data-testid="exhibit-stage"
			>
				<Component {...props} />
			</Surface>
			<Surface as="aside" tone="raised" radius="md" border padding="md" className={styles.panel}>
				<h3 className={styles.panelTitle}>Controls</h3>
				<PropKnobs schema={exhibit.knobs} values={values} onChange={setKnob} />
			</Surface>
		</div>
	);
}
