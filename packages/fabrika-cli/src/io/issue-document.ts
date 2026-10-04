import {Schema} from "effect";

const fields = {
	number: Schema.Int.check(Schema.isGreaterThan(0)),
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
};
const timestamp = Schema.String.check(
	Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);

export const IssueDocument = Schema.Union([
	Schema.Struct({...fields, state: Schema.Literal("open"), closed_at: Schema.Null}),
	Schema.Struct({...fields, state: Schema.Literal("closed"), closed_at: timestamp}),
]);
export type IssueDocument = typeof IssueDocument.Type;
