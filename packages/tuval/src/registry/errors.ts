import {Schema} from "effect";
import {ProgramId} from "./program.ts";

export class DuplicateProgramId extends Schema.TaggedError<DuplicateProgramId>()(
	"tuval/DuplicateProgramId",
	{
		id: ProgramId,
		first: Schema.String,
		second: Schema.String,
	},
) {
	override get message(): string {
		return `program id "${this.id}" is already registered by ${this.first}; refusing ${this.second}`;
	}
}

export class ProgramNotFound extends Schema.TaggedError<ProgramNotFound>()(
	"tuval/ProgramNotFound",
	{id: ProgramId},
) {
	override get message(): string {
		return `no program is registered under id "${this.id}"`;
	}
}
