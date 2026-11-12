// Prints one graph collection as JSON, for checking the orca parsing without the UI.
import { collectGraph } from './orca.mjs';

const started = Date.now();
const graph = await collectGraph();
console.log(JSON.stringify(graph, null, 2));
console.error(`collected ${graph.nodes.length} nodes, ${graph.edges.length} edges in ${Date.now() - started}ms`);
