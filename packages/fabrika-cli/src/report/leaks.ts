/**
 * The body-surface leak predicate, shared by every verb that posts authored text to a public
 * artifact.
 *
 * A machine-local path, an email address or a name the repo keeps private, in a body posted to a
 * public issue, is a leak, and no merge gate covers it — the repo's committed-file leak gate decides
 * whether a *file in a diff* carries one, and a runtime issue body is never in a diff. This is the
 * ungated surface, not a second verdict on a gated one.
 *
 * **Four structural shapes, and names only from the adopter's own config.** The three path roots and
 * the email shape are structural, so a new operator, a renamed tool directory or a different machine
 * needs no edit here. The only names this predicate refuses are the ones a repo declares under
 * `leakNames` ([`config/keys/leak-names.ts`](../config/keys/leak-names.ts)); a caller that passes
 * none gets the structural shapes alone.
 */

import {type LeakNames, NO_LEAK_NAMES} from "../config/keys/leak-names.ts";
import {type ReasonHistogram, reasonHistogram} from "../evidence.ts";

export type LeakClass =
	| "home-relative"
	| "absolute home root"
	| "temp root"
	| "email"
	| "private repo link"
	| "private repo reference"
	| "named identifier";

export interface Leak {
	/** 1-based line number in the scanned body — what the refusal prints. */
	readonly line: number;
	readonly class: LeakClass;
	readonly text: string;
}

export interface Scan {
	readonly leaks: ReadonlyArray<Leak>;
	/** The body with every match masked to its class root. Equal to the input when there are none. */
	readonly redacted: string;
}

/**
 * The claude CLI's public config leaves these two files, byte-identical on every machine and
 * naming nothing operator-specific. Each carve-out pins the **exact** leaf, so a deeper descent or
 * a longer name still matches.
 */
const CARVE_OUTS = new Set(["~/.claude.json", "~/.claude/settings.json"]);

/** Where a match sits in the line it came from, so a rule can read the code shape around it. */
interface Site {
	readonly line: string;
	/** Offset of the first character of the untrimmed match. */
	readonly start: number;
	/** Offset one past the last character of the untrimmed match. */
	readonly end: number;
}

const IDENT = String.raw`[\w$]+`;
const NAMED = String.raw`\{[^{}'"\x60]*\}`;
const NAMESPACE = String.raw`\*(?:\s+as\s+${IDENT})?`;
/** The bindings between `import`/`export` and `from`: a default, a `{…}` list, `* as x`, or a pair. */
const CLAUSE = String.raw`(?:type\s+)?(?:${IDENT}(?:\s*,\s*(?:${NAMED}|${NAMESPACE}))?|${NAMED}|${NAMESPACE})`;
/** Where a statement can begin on a line: its start, after a `;`, or after an inline-code backtick. */
const STATEMENT = String.raw`(?:^|[;\x60])\s*`;

/**
 * A quote opening a module specifier, ending the text before a match: an `import`/`export … from`
 * clause or a side-effect `import` beginning a statement, a `} from` closing a multi-line clause,
 * or an `import(`/`require(` call. The word `from` or `import` in a sentence is none of these, so a
 * quoted path after it still refuses. Node and bundlers never expand `~` in a module specifier, so
 * a path filling that quote pair is a path alias, not a home path.
 */
const SPECIFIER_OPENER = new RegExp(
	String.raw`(?:${STATEMENT}(?:(?:import|export)\s+${CLAUSE}\s*from|import|\}\s*from)|\b(?:import|require)\s*\()\s*(["'])$`,
);

/** A quote ending the text before a match — the opener of a path-mapping key. */
const KEY_OPENER = /(["'])$/;

/**
 * The two code shapes a tilde-slash path alias appears in, each pinned by the text around the
 * match rather than by which directories it names: the whole content of a quote pair that is a
 * module specifier, or a quoted path-mapping key whose last segment is `*` and which a `:` follows
 * (the tsconfig/jsconfig `paths` key). A bare or backticked path in prose is neither, so it still
 * refuses — nothing in the text tells an alias there from a real home path.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10233
 */
const isPathAlias = ({line, start, end}: Site): boolean => {
	const quoted = line.slice(start, end);
	const before = line.slice(0, start);
	const after = line.slice(end);
	if (!quoted.startsWith("~/")) return false;
	const specifier = SPECIFIER_OPENER.exec(before)?.[1];
	if (specifier !== undefined && after.startsWith(specifier)) return true;
	const key = KEY_OPENER.exec(before)?.[1];
	return (
		key !== undefined &&
		quoted.endsWith("/*") &&
		after.startsWith(key) &&
		/^\s*:/.test(after.slice(key.length))
	);
};

/** One path segment: anything up to a separator or a character that ends a run in prose/markdown. */
const SEG = String.raw`[^\s\x60'"<>)\]}/]+`;

/**
 * The roots, **longest first** so an overlapping pair cannot corrupt each other: `/private/tmp`
 * must win over `/tmp`, and `/private/var` over a bare `/var`. A single left-to-right pass over
 * this alternation is what gives "longer matches are replaced before shorter ones".
 *
 * Every alternative requires at least one following segment, so the word `/tmp` in prose is not a
 * path and a bare `~` is not a home reference.
 */
const PATH_RE = new RegExp(
	`(?:/private/tmp|/private/var|/var/folders|/tmp|/Users|/home|~)(?:/${SEG})+`,
	"g",
);

/** Trailing sentence punctuation is prose, not part of the path. */
const trimPunctuation = (match: string): string => match.replace(/[.,;:!?]+$/, "");

const ROOTS: ReadonlyArray<{prefix: string; cls: LeakClass; mask: string}> = [
	{prefix: "/private/tmp", cls: "temp root", mask: "/private/tmp/<redacted>"},
	{prefix: "/private/var", cls: "temp root", mask: "/private/var/<redacted>"},
	{prefix: "/var/folders", cls: "temp root", mask: "/var/folders/<redacted>"},
	{prefix: "/tmp", cls: "temp root", mask: "/tmp/<redacted>"},
	{prefix: "/Users", cls: "absolute home root", mask: "/Users/<redacted>"},
	{prefix: "/home", cls: "absolute home root", mask: "/home/<redacted>"},
	{prefix: "~", cls: "home-relative", mask: "~/<redacted>"},
];

const rootOf = (path: string): {cls: LeakClass; mask: string} =>
	ROOTS.find((r) => path.startsWith(r.prefix)) ?? {cls: "temp root", mask: "/tmp/<redacted>"};

/**
 * An email address: a local part, `@`, and a dotted domain ending in an alphabetic label.
 *
 * The left lookbehind keeps an address from starting mid-token, and the right lookahead keeps a
 * longer label from being cut to a shorter one that happens to match.
 */
const EMAIL_RE =
	/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+([A-Za-z]{2,}))(?![A-Za-z0-9-])/g;

/** Role local parts that name a service rather than a person: commit trailers and SSH remotes. */
const ROLE_LOCAL_PARTS = new Set(["noreply", "no-reply", "git"]);

/** The top-level names RFC 2606 and RFC 6761 reserve, so an address under them names nobody. */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAIN = /(?:^|\.)example\.(?:com|net|org)$/i;

/**
 * File extensions, which make `name@version.patch` and `shot@desktop.png` look like addresses.
 * `md` and `zip` are also delegated top-level domains, kept here because a filename is far likelier
 * in a body than an address under either.
 */
const FILE_EXTENSIONS = new Set(
	"png jpg jpeg gif webp svg avif ico patch diff md mdx txt log json jsonc yml yaml toml ts tsx mts cts js jsx mjs cjs html css lock tgz zip".split(
		" ",
	),
);

const isPersonalAddress = (local: string, domain: string, tld: string): boolean =>
	!ROLE_LOCAL_PARTS.has(local.toLowerCase()) &&
	!RESERVED_TLDS.has(tld.toLowerCase()) &&
	!RESERVED_DOMAIN.test(domain) &&
	!FILE_EXTENSIONS.has(tld.toLowerCase());

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Characters that end a link in prose or markdown, as {@link SEG} does for a path. */
const LINK_TAIL = String.raw`[^\s\x60'"<>)\]}]*`;

/** One pass over a line: a pattern, and what each match becomes — a leak, or `null` to keep it. */
interface Rule {
	readonly re: RegExp;
	readonly judge: (
		match: string,
		groups: ReadonlyArray<string | undefined>,
		site: Site,
	) => {cls: LeakClass; mask: string} | null;
	/** Whether trailing sentence punctuation is split off before judging, as a path's is. */
	readonly trims: boolean;
}

const PATH_RULE: Rule = {
	re: PATH_RE,
	trims: true,
	judge: (path, _groups, site) => (CARVE_OUTS.has(path) || isPathAlias(site) ? null : rootOf(path)),
};

const EMAIL_RULE: Rule = {
	re: EMAIL_RE,
	trims: false,
	judge: (_match, [local = "", domain = "", tld = ""]) =>
		isPersonalAddress(local, domain, tld) ? {cls: "email", mask: "<redacted email>"} : null,
};

/**
 * The rules a repo's declared names add. A private repo's link is `github.com/<slug>` with or
 * without a scheme, optionally `.git`, and whatever path follows; its reference is `<slug>#<n>`.
 * Neither matches the bare slug, which is the one form a public body may carry.
 */
const nameRules = (names: LeakNames): ReadonlyArray<Rule> => {
	const rules: Rule[] = [];
	for (const slug of names.privateRepos) {
		const escaped = escapeRegExp(slug);
		rules.push({
			re: new RegExp(
				String.raw`(?:https?://)?(?:www\.)?github\.com/${escaped}(?:\.git)?(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])${LINK_TAIL}`,
				"gi",
			),
			trims: true,
			judge: () => ({cls: "private repo link", mask: "<redacted private repo link>"}),
		});
		rules.push({
			re: new RegExp(String.raw`(?<![A-Za-z0-9_./-])(${escaped})#\d+(?![0-9])`, "gi"),
			trims: false,
			judge: (_match, [written = slug]) => ({
				cls: "private repo reference",
				mask: `${written}#<redacted>`,
			}),
		});
	}
	for (const identifier of names.identifiers) {
		rules.push({
			re: new RegExp(escapeRegExp(identifier), "gi"),
			trims: false,
			judge: () => ({cls: "named identifier", mask: "<redacted>"}),
		});
	}
	return rules;
};

/**
 * Scan a body for leaks, and produce the masked body alongside.
 *
 * The rules run in order over each line, each over what the one before left: paths first, so a
 * path whose segments hold an address or a name is masked whole as the path it is.
 *
 * A path's mask keeps the class root — `/var/folders/<redacted>`, not one collapsed marker — because
 * *which* root a path came from is itself the evidence. The leaf filename does not survive, and
 * that is deliberate: a filename can identify a person or a machine, and a reader who needs it can
 * ask the reporter. An address is masked whole, domain included, because the domain alone can name
 * an employer.
 */
export const scanBody = (body: string, names: LeakNames = NO_LEAK_NAMES): Scan => {
	const rules = [PATH_RULE, ...nameRules(names), EMAIL_RULE];
	const leaks: Leak[] = [];
	const lines = body.split("\n").map((line, index) =>
		rules.reduce((text, rule) => {
			rule.re.lastIndex = 0;
			return text.replace(rule.re, (raw: string, ...rest: unknown[]) => {
				// `replace` hands the capture groups first, then the numeric offset.
				const offsetAt = rest.findIndex((part) => typeof part === "number");
				const groups = rest.slice(0, offsetAt) as ReadonlyArray<string | undefined>;
				const start = rest[offsetAt] as number;
				const match = rule.trims ? trimPunctuation(raw) : raw;
				const tail = raw.slice(match.length);
				const verdict = rule.judge(match, groups, {line: text, start, end: start + raw.length});
				if (verdict === null) return raw;
				leaks.push({line: index + 1, class: verdict.cls, text: match});
				return verdict.mask + tail;
			});
		}, line),
	);
	return {leaks, redacted: leaks.length === 0 ? body : lines.join("\n")};
};

/**
 * Whether the body's first non-whitespace run is an `@`-prefixed path.
 *
 * That is the composed body having never arrived at all: a posting flag that does not expand `@`
 * ships the literal path into a public artifact and leaves the description empty. It refuses on its
 * own code because the fix is to send the body, not to mask a placeholder.
 */
export const isBareAtReference = (body: string): boolean => {
	const first = body.trim().split(/\s/)[0] ?? "";
	return first.startsWith("@") && first.includes("/");
};

export const renderLeaks = (leaks: ReadonlyArray<Leak>): ReadonlyArray<string> =>
	leaks.map((leak) => `  line ${leak.line}, ${leak.class}`);

/**
 * What `report file` and `report note` print for a redacted body: one count per {@link LeakClass}.
 *
 * `redactions` is an evidence-array collapsed to a per-class tally — no skill reads a row, and both
 * verbs already emit a `line <n>, <class>` note per hit on the notes channel, so the rows on the
 * answer channel were a second copy of a diagnostic. The class is the whole vocabulary a reader acts
 * on.
 */
export const redactionTally = (leaks: ReadonlyArray<Leak>): ReasonHistogram =>
	reasonHistogram(leaks, (leak) => leak.class);
