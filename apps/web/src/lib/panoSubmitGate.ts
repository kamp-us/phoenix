/**
 * The pano submit gate: whether "paylaş" is disabled, and — the reason #2201 fixed —
 * whether the missing tag is the *sole* remaining blocker, so the composer can name that
 * silent requirement inline instead of leaving the button dead with no explanation.
 */

/** Field-validity inputs. `titleInvalid` folds empty + below-min into one blocker. */
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
	/** True iff no tag is selected AND every other field is valid — the reason to surface inline. */
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
