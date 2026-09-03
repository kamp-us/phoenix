// Your Tuval config. This file is yours: boot imports it and registers every program row in the
// list it default-exports. A row is a `Program` (src/registry/program.ts); empty until the
// in-the-box programs land.
import type {AnyProgram} from "./src/registry/program.ts";

const programs: ReadonlyArray<AnyProgram> = [];

export default programs;
