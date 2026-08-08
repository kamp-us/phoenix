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
	/** Who writes these bytes. */
	readonly producers: ReadonlyArray<string>;
	/** Who reads them. */
	readonly consumers: ReadonlyArray<string>;
	/** Fields (as bytes) → the format's bytes. */
	readonly emit: (fields: string) => WireEmit;
	/** An artifact's bytes → the total read, with `Found` rendered to stdout lines. */
	readonly read: (artifact: string) => WireReadLines;
}
