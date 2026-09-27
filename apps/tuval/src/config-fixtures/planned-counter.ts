/** `one-counter`'s row, planned as graph node `main`: a layer whose node's process id gets scoped. */
import oneCounter from "./one-counter.ts";

export default {...oneCounter, graph: {nodes: [{id: "main", program: "counter", on: []}]}};
