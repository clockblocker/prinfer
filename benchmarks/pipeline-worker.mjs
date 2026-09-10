import { performance } from "node:perf_hooks";

const hotSamples = Number(process.env.PRINFER_BENCH_HOT_SAMPLES ?? 7);
const fixture = "src/__tests__/fixtures/sample.ts";
const runtimeStarted = performance.now();
const module = await import("../dist/index.js");
const imported = performance.now();
const samples = [];

for (let index = 0; index < hotSamples + 1; index++) {
	let started = performance.now();
	const result = module.hover(fixture, "add");
	const coreMs = performance.now() - started;

	started = performance.now();
	const response = module.hoverSuccess(result);
	const contractMs = performance.now() - started;

	started = performance.now();
	JSON.stringify(response);
	const serializeMs = performance.now() - started;

	samples.push({ coreMs, contractMs, serializeMs });
}

console.log(
	JSON.stringify({ importMs: imported - runtimeStarted, samples }),
);
