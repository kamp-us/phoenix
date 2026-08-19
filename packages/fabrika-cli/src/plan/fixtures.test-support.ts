/**
 * The canned `gh` responses the `plan` verb tests script their spawner with.
 *
 * Shaped like the real payloads rather than like the parsers, so a parser that starts reading a
 * different field still has to find it here — a fixture trimmed to exactly what the code reads today
 * stops being able to catch tomorrow's misread. The child payload carries its `assignees` key by
 * default and {@link child} can drop it entirely, because *the key was not there* is the fact
 * `UNVERIFIABLE_ASSIGNEE` rests on and no fixture that always includes it could exercise the split.
 */

import type {FileSystem, Path} from "effect";
import {Layer} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import {fakeFs, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

export const EPIC = 4300;
export const SESSION = "s-9f2e";

/** An epic body with one phase line, two contiguous stories, and no fenced decoys. */
export const epicBody = (overrides: {dependencies?: string; stories?: string} = {}): string =>
	[
		"An epic.",
		"",
		"### User stories",
		"",
		overrides.stories ??
			"1. As a planner, I want a gate.\n2. As a builder, I want pickable children.",
		"",
		"## Dependencies",
		"",
		overrides.dependencies ?? "- phase 1: #4301, #4302",
		"",
	].join("\n");

export const epic = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: EPIC,
			title: "The plan gate",
			body: epicBody(),
			state: "open",
			labels: [{name: "type:epic"}],
			html_url: "https://github.com/o/r/issues/4300",
			milestone: null,
			state_reason: null,
			...overrides,
		}),
	);

export const subIssues = (...numbers: ReadonlyArray<number>): ExecResult =>
	okOut(
		JSON.stringify(
			numbers.map((number) => ({
				number,
				title: `child ${number}`,
				state: "open",
				state_reason: null,
			})),
		),
	);

/** A child body that clears the floor: criteria, a story claim, and a containment marker. */
export const childBody = (
	overrides: {stories?: string | null; containment?: string | null; criteria?: string} = {},
): string =>
	[
		"### Acceptance criteria",
		"",
		overrides.criteria ?? "- [ ] the verb runs\n- [ ] the guard reds",
		"",
		overrides.stories === null ? "" : `**Stories:** ${overrides.stories ?? "1, 2"}`,
		overrides.containment === null ? "" : `**Containment:** ${overrides.containment ?? "flag"}`,
		"",
	].join("\n");

export const child = (options: {
	number: number;
	labels?: ReadonlyArray<string>;
	assignees?: ReadonlyArray<string> | null;
	body?: string;
	state?: string;
}): ExecResult =>
	okOut(
		JSON.stringify({
			number: options.number,
			title: `child ${options.number}`,
			body: options.body ?? childBody(),
			state: options.state ?? "open",
			labels: (options.labels ?? ["type:feature", "p1", "status:planned"]).map((name) => ({name})),
			// `null` drops the key entirely — the unobserved slot, not an observed-empty one.
			...(options.assignees === null
				? {}
				: {assignees: (options.assignees ?? []).map((login) => ({login}))}),
			html_url: `https://github.com/o/r/issues/${options.number}`,
		}),
	);

export const labelSet = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(`${names.join("\n")}\n`);

/** The directory a plan verb under test is standing in. Its config is the one the load reads. */
export const CWD = "/repo";

/**
 * The context a plan verb needs: the scripted shell, plus a filesystem carrying `config` as this
 * repo's `.fabrika.jsonc` — or carrying none, which is the shipped-vocabulary case every existing
 * test runs in.
 *
 * `unreadable` is its own arm rather than an absent file, because that is the pair the config
 * surface exists to keep apart: absent resolves to the shipped vocabulary, denied leaves the floor
 * UNKNOWN.
 */
export const planContext = (
	shell: {readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>},
	config?: string | {readonly unreadable: true},
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> => {
	const path = `${CWD}/${CONFIG_PATH}`;
	const files = config === undefined ? {} : {[path]: typeof config === "string" ? config : ""};
	const unreadable = config === undefined || typeof config === "string" ? [] : [path];
	return Layer.merge(shell.layer, fakeFs({files, unreadable}).layer);
};
