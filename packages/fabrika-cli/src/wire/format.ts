/**
 * What a wire format is, as a type — the shape every schema module fills and the registry lists.
 *
 * A wire format is the byte-level agreement two skills meet through on a GitHub artifact. Its
 * schema module owns the bytes and nothing else: composing them ({@link WireFormat.emit}) and
 * reading them back ({@link WireFormat.read}). Which deviation class a finding belongs to, when a
 * criterion is worth writing — those judgements stay in the skills.
 *
 * **`read` is total, and its three answers are the reason this type exists.** A reader whose
 * failure mode is "return the well-formed empty value" is indistinguishable, at the call site, from
 * one that genuinely found nothing — so a heading that drifted by one character reads back as "this
 * issue has no acceptance criteria" and a grader passes over nothing. {@link WireRead} admits no
 * such value: `Found` carries a {@link NonEmptyReadonlyArray} by construction, so "found, but
 * empty" is not a representable state, and every non-conforming input lands on `Absent` or
 * `Malformed` with a reason attached.
 */

/** An array the type system knows holds at least one element. */
export type NonEmptyReadonlyArray<A> = readonly [A, ...ReadonlyArray<A>];

/** The artifact was read in full and the block is provably not in it. */
export interface WireAbsent {
	readonly _tag: "Absent";
	readonly reason: string;
}

/** Something in the artifact means to be the block and does not conform. */
export interface WireMalformed {
	readonly _tag: "Malformed";
	readonly reason: string;
	/** The offending bytes, quoted back so the caller can see what was judged. */
	readonly evidence: string;
}

/** The block is present and conforms. `value` is non-empty wherever the format's value is a list. */
export interface WireFound<A> {
	readonly _tag: "Found";
	readonly value: A;
}

/** Exactly three answers. A fourth would have to be added here, in the open. */
export type WireRead<A> = WireFound<A> | WireAbsent | WireMalformed;

/** Fields composed into the format's bytes. */
export interface WireComposed {
	readonly _tag: "Composed";
	readonly bytes: string;
}

/** The fields hold nothing this format can compose a conforming block from. */
export interface WireUnusable {
	readonly _tag: "Unusable";
	readonly reason: string;
}

export type WireEmit = WireComposed | WireUnusable;

/** {@link WireRead} with the format's value already rendered to the adapter's stdout lines. */
export type WireReadLines = WireRead<NonEmptyReadonlyArray<string>>;

/**
 * The fields a round-trip is driven from, plus what surviving the round-trip means.
 *
 * `values` is the non-tautological half: it lists the field *values* `fields` carries, and the
 * conformance law is that every one of them is still in `read`'s answer. A format that drops a
 * field on the way out composes and reads back perfectly well — the answer is just quietly smaller
 * than what was written, which is the same plausible-value failure the whole group exists to remove.
 */
export interface WireRoundTripFixture {
	/** The fields exactly as {@link WireFormat.emit} takes them. */
	readonly fields: string;
	/** Every field value `fields` carries. Each must survive into the read's answer. */
	readonly values: NonEmptyReadonlyArray<string>;
}

/** An artifact that reaches for the format's block and misses. */
export interface WireMalformedFixture {
	/** What drifted, so a broken law names the case rather than an index. */
	readonly drift: string;
	readonly artifact: string;
}

/**
 * The samples the conformance suite drives a row through, carried by the row itself.
 *
 * Fixtures live on the registry rather than in the suite so the suite never learns a format's name:
 * a new format inherits the laws by filling these in, and — because every field here is required —
 * a row added without them does not compile, rather than silently reducing coverage to the formats
 * whose author remembered to write tests.
 */
export interface WireFixtures {
	readonly roundTrip: WireRoundTripFixture;
	/** An artifact that genuinely carries no block: `Absent`, never `Malformed`. */
	readonly absent: string;
	/** At least one drift: `Malformed`, never `Found` and never `Absent`. */
	readonly malformed: NonEmptyReadonlyArray<WireMalformedFixture>;
}

const WITNESSED: unique symbol = Symbol("wire brand witness");

/**
 * A field of the format's value whose type is a brand rather than a bare `string`.
 *
 * Unforgeable on purpose. {@link WITNESSED} is a module-private `unique symbol`, so a hand-written
 * `{field: "sha"}` is not a witness and {@link brandWitnesses} is the only way to build one. Without
 * that, the per-field coverage that function enforces would be a convention a row could opt out of
 * by hand-rolling the array — and a guard a row can opt out of is the shape of defect #4969 is about.
 */
export interface WireBrandWitness {
	readonly field: string;
	readonly [WITNESSED]: true;
}

/** `true` only for a *proper* subtype of `string` — a brand, or a literal union. Bare `string` is `false`. */
type NarrowerThanString<A> = [A] extends [string] ? ([string] extends [A] ? false : true) : false;

/**
 * Exactly the code points `String.prototype.trim` strips, so {@link IsBlank} is not narrower than
 * the runtime law it replaces: ECMAScript `WhiteSpace` (§12.2 — TAB, VT, FF, ZWNBSP, and every
 * `Space_Separator`) plus `LineTerminator` (§12.3 — LF, CR, LS, PS). Enumerating them by hand is the
 * only option at the type level, so the list was re-derived from the runtime rather than recalled:
 * scanning every code point for one `trim()` removes yields these 25 and no others.
 */
type Whitespace =
	| "\u0009"
	| "\u000A"
	| "\u000B"
	| "\u000C"
	| "\u000D"
	| "\u0020"
	| "\u00A0"
	| "\u1680"
	| "\u2000"
	| "\u2001"
	| "\u2002"
	| "\u2003"
	| "\u2004"
	| "\u2005"
	| "\u2006"
	| "\u2007"
	| "\u2008"
	| "\u2009"
	| "\u200A"
	| "\u2028"
	| "\u2029"
	| "\u202F"
	| "\u205F"
	| "\u3000"
	| "\uFEFF";

/** `true` for the empty key and for one made only of whitespace — a name that names nothing. */
type IsBlank<K extends string> = K extends ""
	? true
	: K extends `${Whitespace}${infer Rest}`
		? IsBlank<Rest>
		: false;

/**
 * The fields of `V` whose type is a proper subtype of `string`.
 *
 * This is the binding the old `brandWitness<A>(field)` lacked (#4969): `A` was supplied at the call
 * site and appeared nowhere but in a guard on a plain `string` parameter, so it asserted only "the
 * type I named is not bare `string`" — true of any surviving brand anywhere in the module. Here the
 * brand is *derived from the field*, so naming one brand while witnessing another is not a mistake
 * to catch, it is unrepresentable; and a field name that is not a key of `V` is not in this union at
 * all. Weaken a brand to bare `string` and its key leaves the union, so the row stops compiling.
 *
 * A blank or whitespace-only key is excluded too, so "a witness names no field" is unrepresentable
 * rather than merely unlikely — that half of the retired `brandsNamed` runtime law is carried here.
 */
export type BrandedKeys<V> = {
	[K in keyof V]-?: NarrowerThanString<V[K]> extends true
		? K extends string
			? IsBlank<K> extends true
				? never
				: K
			: K
		: never;
}[keyof V] &
	string;

/**
 * Every branded field of `V`, each acknowledged by name — a witness per field, not per row.
 *
 * A mapped type over {@link BrandedKeys} makes each key **required**, so omitting one is `TS2741`
 * and naming a non-branded or non-existent field is an excess property. That settles the coverage
 * question the type used to leave open: `brands` needed only *one* witness, so weakening any other
 * branded field on the same format was caught by nothing.
 *
 * `never` when `V` has no branded field, which makes such a call unwritable rather than a row with
 * an empty `brands` — zero scope is a refusal (ADR 0092).
 */
export type WireBrandWitnesses<V> = [BrandedKeys<V>] extends [never]
	? never
	: {readonly [K in BrandedKeys<V>]: true};

/**
 * Build a row's `brands` from its value type — the compile-time half of the conformance laws.
 *
 * **The residue, stated rather than implied (#4969).** The row still chooses which `V` to name, and
 * nothing binds that choice to the row's own `emit`/`read`: {@link WireFormat} is stated over bytes
 * so one array can hold formats whose values have nothing in common, and that erasure is what would
 * have to go to close the last gap. So this device enforces *field ↔ brand* agreement and per-field
 * coverage, and takes *which value type a row names* on trust.
 *
 * A second residue, for the same reason: excess-property checking is *freshness*-based, so an
 * argument hoisted into a `const` before the call skips it and a stray key rides through. Every
 * registry row passes the object literal inline, which is the form that is checked.
 */
export const brandWitnesses = <V>(
	witnessed: WireBrandWitnesses<V>,
): NonEmptyReadonlyArray<WireBrandWitness> => {
	const [first, ...rest] = Object.keys(witnessed).map(
		(field): WireBrandWitness => ({field, [WITNESSED]: true}),
	);
	if (first === undefined) {
		// Unreachable through the parameter type, which is `never` for a `V` with no branded field.
		// A silently empty `brands` would be the zero-scope pass ADR 0092 forbids, so it throws.
		throw new Error("brandWitnesses was handed no branded field to witness");
	}
	return [first, ...rest];
};

/**
 * A registered format: its identity, its wiring, and its bytes.
 *
 * The `emit`/`read` pair is stated over **bytes in, bytes out** so one array can hold formats whose
 * values have nothing in common. Each schema module keeps its own typed core — the field type, the
 * typed read — and the row adapts it; the typing is not lost, it is bound at the row.
 */
export interface WireFormat {
	/** The `--format` selector. Kebab-case, and the row's identity. */
	readonly key: string;
	/** One line: what agreement this format encodes. */
	readonly purpose: string;
	/**
	 * The repo-relative path of the schema module that owns these bytes.
	 *
	 * Carried on the row so the index doc's owner-module link is rendered from the registry rather
	 * than typed beside it — see `./index-doc.ts` (#4968).
	 */
	readonly module: string;
	/** Who writes these bytes. */
	readonly producers: ReadonlyArray<string>;
	/** Who reads them. */
	readonly consumers: ReadonlyArray<string>;
	/** Fields (as bytes) → the format's bytes. */
	readonly emit: (fields: string) => WireEmit;
	/** An artifact's bytes → the total read, with `Found` rendered to stdout lines. */
	readonly read: (artifact: string) => WireReadLines;
	/** The samples `./conformance.ts` drives this row's laws from. Required — see {@link WireFixtures}. */
	readonly fixtures: WireFixtures;
	/** The brands this format's value is built from. Non-empty, so the check has scope (ADR 0092). */
	readonly brands: NonEmptyReadonlyArray<WireBrandWitness>;
}
