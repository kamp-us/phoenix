/**
 * The note a PR's owner reads when the ui gate ends CANT-SEE for want of a preview: what is owed,
 * in everyday words, and exactly what to post to get past it.
 *
 * The route verb composes it from the facts it already read, so the note names the head it refused
 * at and the comments that came close. A reviewer writing it freehand passed on neither.
 *
 * **The ready-to-paste comment must never itself read as a screenshot.** The note is posted by the
 * reviewing account and names the head, so on a repo where that account is an owner, an image
 * placeholder in it would make the note its own admitted hand-check.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10368
 */
import type {NearMiss} from "./hand-check.ts";

/** The note's first line, and how a later run recognises one it posted. */
export const CANT_SEE_HEADING = "**The UI review could not look at this pull request.**";

export const isCantSeeNote = (body: string): boolean => body.includes(CANT_SEE_HEADING);

const NO_PREVIEW =
	"This pull request changes what users see, and there is no preview deploy for the review to open. A preview deploy is a test copy of the app that CI puts online for each pull request.";

const RERUN = "Then run the UI review again.";

/** How many near misses the note lists, newest kept. */
const NEAR_MISS_LIMIT = 3;

export interface NoteSubject {
	readonly repo: string;
	readonly pr: number;
}

const nearMissLine = (subject: NoteSubject, miss: NearMiss): string => {
	const link = `[This comment](https://github.com/${subject.repo}/pull/${subject.pr}#issuecomment-${miss.comment.id}) by \`${miss.comment.author}\``;
	switch (miss.fact) {
		case "screenshot":
			return `- ${link} names the right commit but has no screenshot image.`;
		case "author":
			return `- ${link} names the right commit and has a screenshot, but \`${miss.comment.author}\` is not an owner account.`;
		case "evidence":
			return `- ${link} names the right commit and has a screenshot, but it is the builder's own evidence comment, which an agent posts.`;
		case "stamp":
			return `- ${link} names the right commit and has a screenshot, but it carries an agent's stamp, so an agent posted it.`;
	}
};

/** The note under a `hand-check` rule with no admitted comment at `head`. */
export const handCheckNote = (
	subject: NoteSubject,
	head: string,
	misses: ReadonlyArray<NearMiss>,
): string => {
	const listed = misses.slice(-NEAR_MISS_LIMIT);
	return [
		CANT_SEE_HEADING,
		"",
		`${NO_PREVIEW} This repo's rules let a hand check stand in for the preview: a comment from an owner account, with a screenshot. The review is waiting for that comment.`,
		"",
		"**What to do.** Post one new comment on this pull request from an owner account: the text below, with a screenshot of the change in place of the second line.",
		"",
		"```text",
		`Hand-checked at ${head}.`,
		"",
		"(replace this line with your screenshot: drag the image file into the comment box)",
		"```",
		"",
		"- **Add a screenshot image.** A comment with only text does not count.",
		"- **An owner account posts it.** That is an account on a control-plane row of `.github/CODEOWNERS`. The review checks the account, not who typed the comment.",
		`- **A new push needs a new comment.** The long code in the text is the head: the newest commit on this pull request, \`${head}\` right now. Every push makes a new head, and a comment naming an old one stops counting.`,
		"",
		RERUN,
		...(listed.length === 0
			? []
			: [
					"",
					"**Comments that came close but did not count.**",
					"",
					...listed.map((miss) => nearMissLine(subject, miss)),
				]),
	].join("\n");
};

/** The note under `require-render`, naming the files that set the mode. */
export const requireRenderNote = (files: ReadonlyArray<string>): string =>
	[
		CANT_SEE_HEADING,
		"",
		`${NO_PREVIEW} This repo's rules ask for a rendered review of the files below, so the pull request cannot ship until one of the ways through is in place.`,
		"",
		...files.map((file) => `- \`${file}\``),
		"",
		"**Ways through.**",
		"",
		"1. **Set up preview deploys.** CI posts a `preview-deploy` comment on the pull request with the deployed address and the head, which is the newest commit on the pull request. The UI review opens that address.",
		"2. **Let the builder's own run of the app stand in.** The builder runs the app at the head and records what it saw. The UI review accepts that run once the code review has passed at the same head.",
		"3. **Let an owner account's screenshot stand in.** Add a `hand-check` rule for these paths under `reviewUi.whenNoPreview` in `.fabrika.jsonc`. An owner account's comment with a screenshot, naming the head, then counts.",
		"4. **Say no rendered review is owed.** Add a `skip` rule for these paths in the same place.",
		"",
		'The details are in fabrika\'s guide "Adopt fabrika in a repo you already have", under "If your app has no preview deploys".',
		"",
		RERUN,
	].join("\n");

const NOTE_BEGINS = "----- note begins -----";
const NOTE_ENDS = "----- note ends -----";

/** The stderr lines a refusal carries the note on, between two markers a caller cuts at. */
export const noteLines = (verb: string, pr: number, note: string): ReadonlyArray<string> => [
	`${verb}: the note for #${pr} follows — send the lines between the two markers to fabrika review-ui note ${pr}, unchanged.`,
	NOTE_BEGINS,
	...note.split("\n"),
	NOTE_ENDS,
];
