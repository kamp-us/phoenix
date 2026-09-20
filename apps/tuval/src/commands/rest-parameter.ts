import {Schema} from "effect";

export const REST_PARAMETER_ANNOTATION = "x-command-rest";

export const RestParameter = Schema.String.annotate({[REST_PARAMETER_ANNOTATION]: true});
