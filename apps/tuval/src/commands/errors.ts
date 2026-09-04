import {Schema} from "effect";

export class DuplicateSpellPath extends Schema.TaggedError<DuplicateSpellPath>()(
	"tuval/commands/DuplicateSpellPath",
	{
		path: Schema.String,
		first: Schema.String,
		second: Schema.String,
	},
) {
	override get message(): string {
		return `spell path "${this.path}" is already registered by ${this.first}; refusing ${this.second}`;
	}
}

/**
 * A spell whose `params` has no JSON Schema form, refused where `DuplicateSpellPath` is: at
 * registration, before it can defect every later description of the table.
 */
export class SpellNotDescribable extends Schema.TaggedError<SpellNotDescribable>()(
	"tuval/commands/SpellNotDescribable",
	{
		path: Schema.String,
		source: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return `spell "${this.path}" from ${this.source} has params no JSON Schema can describe: ${this.reason}`;
	}
}

export class SpellNotFound extends Schema.TaggedError<SpellNotFound>()(
	"tuval/commands/SpellNotFound",
	{path: Schema.String},
) {
	override get message(): string {
		return `no spell is registered at path "${this.path}"`;
	}
}

/** A call named a window the index does not hold. */
export class NoSuchWindow extends Schema.TaggedError<NoSuchWindow>()(
	"tuval/commands/NoSuchWindow",
	{window: Schema.String},
) {
	override get message(): string {
		return `no window "${this.window}" is open`;
	}
}

/** `SpellNotFound` as a caller reads it: the same miss, plus the nearest path the registry holds. */
export class UnknownSpell extends Schema.TaggedError<UnknownSpell>()(
	"tuval/commands/UnknownSpell",
	{path: Schema.String, didYouMean: Schema.optionalKey(Schema.String)},
) {
	override get message(): string {
		const hint = this.didYouMean === undefined ? "" : `; did you mean "${this.didYouMean}"?`;
		return `no spell is registered at path "${this.path}"${hint}`;
	}
}

/** Arguments the spell's `params` refused. `argument` is empty when the whole value is at fault. */
export class BadArgs extends Schema.TaggedError<BadArgs>()("tuval/commands/BadArgs", {
	path: Schema.String,
	argument: Schema.String,
	expected: Schema.String,
}) {
	override get message(): string {
		const at = this.argument.length === 0 ? "" : ` at "${this.argument}"`;
		return `bad arguments for "${this.path}"${at}: ${this.expected}`;
	}
}

/**
 * A spell returned something its own `result` refuses. That is the spell author's bug, so the
 * executor dies on it rather than replying: a caller cannot act on it and must not be told it
 * failed for a reason of its own.
 */
export class BadResult extends Schema.TaggedError<BadResult>()("tuval/commands/BadResult", {
	path: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `spell "${this.path}" returned a result its own schema refuses: ${this.reason}`;
	}
}
