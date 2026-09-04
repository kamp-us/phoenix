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

export class SpellNotFound extends Schema.TaggedError<SpellNotFound>()(
	"tuval/commands/SpellNotFound",
	{path: Schema.String},
) {
	override get message(): string {
		return `no spell is registered at path "${this.path}"`;
	}
}
