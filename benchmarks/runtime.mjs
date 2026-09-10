import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";

const coldSamples = Number(process.env.PRINFER_BENCH_COLD_SAMPLES ?? 3);
const hotSamples = Number(process.env.PRINFER_BENCH_HOT_SAMPLES ?? 7);
const fixture = "src/__tests__/fixtures/sample.ts";
const cliArgs = ["dist/cli.js", `${fixture}:add`, "--json"];

const runtimes = [
	{ name: "node", command: process.execPath },
	{ name: "bun", command: "bun" },
];

function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		meanMs: mean(values),
		medianMs: percentile(sorted, 0.5),
		minMs: sorted[0],
		maxMs: sorted.at(-1),
	};
}

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, fraction) {
	return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function runProcess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const child = spawn(command, args, {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			...options,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("error", reject);
		child.once("exit", (exitCode) => {
			const elapsedMs = performance.now() - started;
			if (exitCode !== 0) {
				reject(
					new Error(
						`${command} exited ${exitCode}: ${stderr || stdout}`,
					),
				);
				return;
			}
			resolve({ elapsedMs, stdout, stderr });
		});
	});
}

async function benchmarkCli(runtime) {
	const cold = await runProcess(runtime.command, cliArgs);
	const hot = [];
	for (let index = 0; index < hotSamples; index++) {
		hot.push((await runProcess(runtime.command, cliArgs)).elapsedMs);
	}
	return { coldMs: cold.elapsedMs, hot: stats(hot) };
}

async function benchmarkStartup(runtime) {
	const args = ["--eval", ""];
	const cold = await runProcess(runtime.command, args);
	const hot = [];
	for (let index = 0; index < hotSamples; index++) {
		hot.push((await runProcess(runtime.command, args)).elapsedMs);
	}
	return { coldMs: cold.elapsedMs, hot: stats(hot) };
}

function createMcpSession(runtime) {
	const launchedAt = performance.now();
	const child = spawn(runtime.command, ["dist/mcp.js"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	let stderr = "";
	let nextId = 1;
	const pending = new Map();

	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				waiter.resolve(message);
			}
		}
	});
	child.once("exit", (code) => {
		for (const waiter of pending.values()) {
			waiter.reject(
				new Error(`MCP server exited ${code}: ${stderr || "no stderr"}`),
			);
		}
	});

	function send(message) {
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	function request(method, params) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			send({ jsonrpc: "2.0", id, method, params });
		});
	}

	return {
		launchedAt,
		request,
		notify(method) {
			send({ jsonrpc: "2.0", method });
		},
		close() {
			child.kill();
		},
	};
}

async function initializeMcp(session) {
	const started = performance.now();
	await session.request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "prinfer-benchmark", version: "1.0.0" },
	});
	session.notify("notifications/initialized");
	return performance.now() - started;
}

async function callMcp(session) {
	const started = performance.now();
	await session.request("tools/call", {
		name: "hoverByName",
		arguments: { file: fixture, name: "add" },
	});
	return performance.now() - started;
}

async function benchmarkMcp(runtime) {
	const coldTotals = [];
	const coldHandshakes = [];
	const coldCalls = [];
	for (let index = 0; index < coldSamples; index++) {
		const session = createMcpSession(runtime);
		const handshakeMs = await initializeMcp(session);
		const callMs = await callMcp(session);
		coldHandshakes.push(handshakeMs);
		coldCalls.push(callMs);
		coldTotals.push(performance.now() - session.launchedAt);
		session.close();
	}

	const session = createMcpSession(runtime);
	const handshakeMs = await initializeMcp(session);
	await callMcp(session);
	const hotCalls = [];
	for (let index = 0; index < hotSamples; index++) {
		hotCalls.push(await callMcp(session));
	}
	session.close();

	return {
		cold: {
			total: stats(coldTotals),
			handshake: stats(coldHandshakes),
			firstCall: stats(coldCalls),
		},
		hot: { handshakeMs, calls: stats(hotCalls) },
	};
}

async function benchmarkPipeline(runtime) {
	const run = await runProcess(runtime.command, [
		"benchmarks/pipeline-worker.mjs",
	]);
	const result = JSON.parse(run.stdout);
	const [cold, ...hot] = result.samples;
	return {
		processTotalMs: run.elapsedMs,
		moduleImportMs: result.importMs,
		cold,
		hot: {
			core: stats(hot.map((sample) => sample.coreMs)),
			contract: stats(hot.map((sample) => sample.contractMs)),
			serialize: stats(hot.map((sample) => sample.serializeMs)),
		},
	};
}

const results = {};
for (const runtime of runtimes) {
	results[runtime.name] = {
		startup: await benchmarkStartup(runtime),
		cli: await benchmarkCli(runtime),
		mcp: await benchmarkMcp(runtime),
		pipeline: await benchmarkPipeline(runtime),
	};
}

console.log(
	JSON.stringify(
		{
			metadata: {
				date: new Date().toISOString(),
				coldSamples,
				hotSamples,
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
			},
			results,
		},
		null,
	2,
	),
);
