/**
 * The pano submit gate. `tagsAreSoleBlocker` exists so the composer can name the silent
 * tag requirement inline instead of leaving the button dead with no explanation (#2201).
 */

/** `titleInvalid` folds empty + below-min into one blocker. */
export interface PanoSubmitFields {
	inFlight: boolean;
	titleInvalid: boolean;
	titleTooLong: boolean;
	bodyTooLong: boolean;
	noTags: boolean;
	linkModeUrlEmpty: boolean;
}

export interface PanoSubmitGate {
	submitDisabled: boolean;
	tagsAreSoleBlocker: boolean;
}

export function panoSubmitGate(f: PanoSubmitFields): PanoSubmitGate {
	const otherFieldsBlock =
		f.inFlight || f.titleInvalid || f.titleTooLong || f.bodyTooLong || f.linkModeUrlEmpty;
	return {
		submitDisabled: otherFieldsBlock || f.noTags,
		tagsAreSoleBlocker: f.noTags && !otherFieldsBlock,
	};
}
