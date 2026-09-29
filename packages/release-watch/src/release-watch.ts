/**
 * The pure decision behind the release watch: given each first-party catalog pin, the npm `latest`
 * for that package, and the open issues this watch already filed, say which packages lag and which
 * single write each one owes. No IO; `bin.ts` reads the three inputs and performs the writes.
 *
 * Dedup is on a body marker, never on title text: {@link watchMarker} is an HTML comment nothing
 * renders, keyed on the package so two lagging packages keep separate issues. It also records the
 * pin and `latest` the issue was written for, and "changed" is read off those versions alone:
 * `triage enrich` keeps the original body, marker included, verbatim, so comparing whole bodies
 * would reset every triaged issue on every run.
 */
import * as semver from "semver";

/** The npm scope this watch covers: the first-party packages phoenix consumes from its catalog. */
export const WATCHED_SCOPE = "@demlik/";

/** Intake's own entry label, so a filed issue is triaged like any other report. */
export const TRIAGE_LABEL = "status:needs-triage";

/** GitHub's default-token identity: the only author whose marker this watch trusts. */
export const ACTIONS_BOT = "github-actions[bot]";

/** What one issue was written for: the package, and the pin and `latest` it reported. */
export interface WatchRecord {
	readonly pkg: string;
	readonly pinned: string;
	readonly latest: string;
}

export const watchMarker = ({pkg, pinned, latest}: WatchRecord): string =>
	`<!-- release-watch pkg=${pkg} pinned=${pinned} latest=${latest} -->`;

const MARKER_RE = /<!-- release-watch pkg=(\S+) pinned=(\S+) latest=(\S+) -->/g;

/** Every watch marker in a body; a rewritten issue can carry more than one. */
export const readWatchMarkers = (body: string): ReadonlyArray<WatchRecord> =>
	Array.from(body.matchAll(MARKER_RE), ([, pkg = "", pinned = "", latest = ""]) => ({
		pkg,
		pinned,
		latest,
	}));

/** One root-`catalog:` entry in the watched scope, exactly as the catalog spells its version. */
export interface CatalogPin {
	readonly name: string;
	readonly spec: string;
}

/** One open issue as the filtered read returned it. */
export interface OpenIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string;
}

export interface IssueText {
	readonly title: string;
	readonly body: string;
}

/** What one watched package needs, and nothing a later reader has to re-derive. */
export type Verdict =
	/** The catalog spec is not one exact version, so there is no single pin to compare. */
	| {readonly _tag: "Unpinned"; readonly name: string; readonly spec: string}
	/** `latest` is not newer than the pin — equal, older, or a prerelease. Nothing to write. */
	| {
			readonly _tag: "Current";
			readonly name: string;
			readonly pinned: string;
			readonly latest: string;
			readonly reason: "same" | "pin-ahead" | "prerelease-latest";
	  }
	| {
			readonly _tag: "File";
			readonly name: string;
			readonly pinned: string;
			readonly latest: string;
			readonly issue: IssueText;
	  }
	| {
			readonly _tag: "Update";
			readonly name: string;
			readonly pinned: string;
			readonly latest: string;
			readonly issueNumber: number;
			readonly issue: IssueText;
	  }
	/** The open issue was written for this same pin and `latest`, so the run writes nothing. */
	| {
			readonly _tag: "AlreadyFiled";
			readonly name: string;
			readonly pinned: string;
			readonly latest: string;
			readonly issueNumber: number;
	  };

export const issueText = (pkg: string, pinned: string, latest: string): IssueText => ({
	title: `${pkg} ${latest} is out; the catalog pins ${pinned}`,
	body: [
		"## In plain words",
		"",
		`npm's \`latest\` for \`${pkg}\` is **${latest}**, and the root \`catalog:\` in \`pnpm-workspace.yaml\` still pins **${pinned}**.`,
		"Bump the pin (and the lockfile with it) when the new release is wanted. A lagging pin blocks nothing.",
		"",
		`- package: \`${pkg}\``,
		`- pinned: \`${pinned}\``,
		`- npm latest: \`${latest}\``,
		"",
		"Filed by the `release-watch` workflow (#10133). A later run updates this issue in place only when the pin or npm `latest` changes, and files no second one while this stays open.",
		"",
		watchMarker({pkg, pinned, latest}),
	].join("\n"),
});

/**
 * Compare one exact pin with npm's `latest`. A prerelease `latest` never counts as a release to
 * move to, and neither does one older than or equal to the pin.
 */
const compare = (
	pinned: string,
	latest: string,
):
	| {readonly newer: true}
	| {readonly newer: false; readonly reason: "same" | "pin-ahead" | "prerelease-latest"} => {
	if (semver.prerelease(latest) !== null) return {newer: false, reason: "prerelease-latest"};
	if (semver.gt(latest, pinned)) return {newer: true};
	return {newer: false, reason: semver.eq(latest, pinned) ? "same" : "pin-ahead"};
};

/**
 * The verdict for one package. `latest` must already be a valid version; the bin refuses a registry
 * answer that is not one rather than letting it read as "current".
 */
export const judge = (
	pin: CatalogPin,
	latest: string,
	openIssues: ReadonlyArray<OpenIssue>,
): Verdict => {
	const pinned = semver.valid(pin.spec);
	if (pinned === null) return {_tag: "Unpinned", name: pin.name, spec: pin.spec};
	const cmp = compare(pinned, latest);
	if (!cmp.newer) return {_tag: "Current", name: pin.name, pinned, latest, reason: cmp.reason};

	const issue = issueText(pin.name, pinned, latest);
	const standing = openIssues
		.map((candidate) => ({
			number: candidate.number,
			records: readWatchMarkers(candidate.body).filter((record) => record.pkg === pin.name),
		}))
		.filter(({records}) => records.length > 0)
		.reduce<{number: number; records: ReadonlyArray<WatchRecord>} | undefined>(
			(oldest, next) => (oldest === undefined || next.number < oldest.number ? next : oldest),
			undefined,
		);
	if (standing === undefined) return {_tag: "File", name: pin.name, pinned, latest, issue};
	const issueNumber = standing.number;
	if (standing.records.some((record) => record.pinned === pinned && record.latest === latest)) {
		return {_tag: "AlreadyFiled", name: pin.name, pinned, latest, issueNumber};
	}
	return {_tag: "Update", name: pin.name, pinned, latest, issueNumber, issue};
};

/** One watched pin beside the npm `latest` read for it. */
export interface Watched {
	readonly pin: CatalogPin;
	readonly latest: string;
}

/** Every watched package's verdict, in catalog order. */
export const planReleaseWatch = (
	watched: ReadonlyArray<Watched>,
	openIssues: ReadonlyArray<OpenIssue>,
): ReadonlyArray<Verdict> => watched.map(({pin, latest}) => judge(pin, latest, openIssues));

export const renderVerdict = (verdict: Verdict): string => {
	switch (verdict._tag) {
		case "Unpinned":
			return `${verdict.name}: catalog spec \`${verdict.spec}\` is not an exact version; not compared`;
		case "Current":
			return `${verdict.name}: current (pinned ${verdict.pinned}, npm latest ${verdict.latest}, ${verdict.reason})`;
		case "File":
			return `${verdict.name}: lags (pinned ${verdict.pinned}, npm latest ${verdict.latest}) — filing an issue`;
		case "Update":
			return `${verdict.name}: lags (pinned ${verdict.pinned}, npm latest ${verdict.latest}) — updating #${verdict.issueNumber}`;
		case "AlreadyFiled":
			return `${verdict.name}: lags (pinned ${verdict.pinned}, npm latest ${verdict.latest}) — #${verdict.issueNumber} already reports these versions`;
	}
};
