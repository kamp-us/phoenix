import {Schema} from "effect";

/**
 * One key binding the config author has to fix. It carries the five things that make a config
 * mistake actionable — which module, which key, where in the command string, what was expected,
 * and the nearest thing they may have meant — and `message` renders all five in that order.
 *
 * `file` is a layer name plus a path relative to the home or project directory (`describeFile`),
 * never a machine-local absolute path: these lines are shown in a status line and printed to a
 * boot log that people paste into issues.
 */
export class BindingError extends Schema.TaggedError<BindingError>()(
	"tuval/commands/BindingError",
	{
		file: Schema.String,
		/** The binding's key string exactly as the config author wrote it. */
		key: Schema.String,
		/** Character offset inside the command string where reading stopped. */
		position: Schema.Number,
		expected: Schema.String,
		didYouMean: Schema.optionalKey(Schema.String),
	},
) {
	override get message(): string {
		const hint = this.didYouMean === undefined ? "" : `; did you mean "${this.didYouMean}"?`;
		return `${this.file}: cannot bind "${this.key}": at character ${this.position}, expected ${this.expected}${hint}`;
	}
}

/** The lines a status line shows and the boot log prints, one per binding that did not compile. */
export const renderBindingErrors = (errors: ReadonlyArray<BindingError>): ReadonlyArray<string> =>
	errors.map((error) => error.message);
