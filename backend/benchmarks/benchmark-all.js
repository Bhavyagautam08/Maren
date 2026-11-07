import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    benchmarkDatabaseName,
    gitCommit,
    machineInfo,
    redisProvider,
    repoRoot,
    resultsDir,
    runId,
    saveRawResult,
    validateBenchmarkEnvironment
} from "./benchmark-utils.js";

const backendDir = resolve(repoRoot, "backend");
const scripts = [
    { id: "seed", file: "seed-benchmark-catalog.js", dependency: null },
    { id: "product", file: "benchmark-product-cache.js", dependency: "seed" },
    { id: "correctness", file: "benchmark-order-correctness.js", dependency: "seed" }
];

const runScript = (file) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [`benchmarks/${file}`], {
        cwd: backendDir,
        env: { ...process.env, BENCHMARK_RUN_ID: runId },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout = `${stdout}${text}`.slice(-50_000);
        process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr = `${stderr}${text}`.slice(-50_000);
        process.stderr.write(text);
    });
    child.once("error", (error) => resolveRun({
        command: `node benchmarks/${file}`,
        exitCode: 1,
        stdout,
        stderr,
        error: error.message
    }));
    child.once("close", (exitCode, signal) => resolveRun({
        command: `node benchmarks/${file}`,
        exitCode: exitCode ?? 1,
        signal,
        stdout,
        stderr
    }));
});

const readResult = async (filename) => {
    try {
        return JSON.parse(await readFile(resolve(resultsDir, filename), "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
};

const valueOrNotRun = (value) => value === undefined || value === null
    ? "Not run"
    : String(value);
const markdownCell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const buildReadme = ({ stages, seed, index, throughput, correctness, suite }) => {
    const indexRows = (index?.results || []).map((result) =>
        `| ${result.scenario} | ${result.classification} | ${result.passed ? "PASS" : "FAIL"} | ${valueOrNotRun(result.totalDocsExamined)} | ${valueOrNotRun(result.executionTimeMillis)} | ${result.winningPlanStages.join(", ") || "Not recorded"} |`
    );
    const throughputRows = ["A", "B", "C"].map((id) => {
        const record = throughput?.results?.find((entry) => entry.scenario?.id === id);
        const failure = throughput?.failures?.find((entry) => entry.scenario === id);
        const load = record?.load;
        const status = markdownCell(
            record?.status || (failure ? `failed: ${failure.error}` : "not run")
        );
        return `| ${id} | ${status} | ${valueOrNotRun(load?.requestsPerSecond)} | ${valueOrNotRun(load?.averageLatencyMs)} | ${valueOrNotRun(load?.p99LatencyMs)} | ${valueOrNotRun(load?.errors)} | [Raw JSON](./results/throughput-${runId}-${id}.json) |`;
    });
    const inventoryRows = (correctness?.inventory?.summary || []).map((result) =>
        `| ${result.concurrency} | ${result.runs} | ${result.passed} | ${result.failed} | ${result.successfulOrders} | ${result.rejectedOrders} | ${result.finalStockZeroRuns}/${result.runs} | ${result.oversellRuns} |`
    );
    const idem = correctness?.idempotency;
    const stageRows = stages.map((stage) =>
        `| ${stage.id} | ${stage.status} | ${stage.exitCode ?? "not run"} | ${markdownCell(stage.error)} |`
    );
    const machine = seed?.machine || machineInfo;
    const claims = [
        `- 100,000-product deterministic seed: ${seed?.status || stages.find((stage) => stage.id === "seed")?.status || "not run"}`,
        `- Index explain comparison: ${index?.results?.filter((result) => result.passed).length ?? 0}/${index?.results?.length ?? 0} expected plans`,
        `- Throughput scenarios recorded: ${throughput?.results?.length ?? 0}/3`,
        `- Inventory races passed: ${correctness?.inventory?.summary?.reduce((sum, item) => sum + item.passed, 0) ?? 0}/${correctness?.inventory?.results?.length ?? 0}`,
        `- Idempotency created exactly one order: ${idem ? (idem.passed ? "yes" : "no") : "not run"}`
    ];

    return [
        "# Maren benchmark suite",
        "",
        `- Run ID: \`${runId}\``,
        `- Status: **${suite.status}**`,
        `- Git commit tested: \`${gitCommit}\``,
        `- MongoDB database: \`${benchmarkDatabaseName || "not configured"}\``,
        `- Redis: ${redisProvider()}`,
        `- Dataset: ${seed?.productCount ?? "not seeded"} products; fixed seed ${seed?.seed ?? "not recorded"}`,
        "",
        "## Machine",
        "",
        `- OS: ${machine.platform}`,
        `- Architecture: ${machine.architecture}`,
        `- Node.js: ${machine.node}`,
        `- CPU: ${machine.cpu} (${machine.cpuCount} logical CPUs)`,
        `- Memory: ${machine.totalMemoryBytes} bytes total; ${machine.freeMemoryBytesAtStart} bytes free at suite start`,
        "",
        "## Product listing index explain",
        "",
        "Query: `products.find({}).sort({ createdAt: -1 }).limit(10).explain(\"executionStats\")`.",
        "",
        `Index restoration after throughput tests: ${index?.restoration || "not recorded"}.`,
        "",
        "| Index scenario | Plan classification | Check | Documents examined | Execution time (ms) | Winning plan stages |",
        "|---|---|---:|---:|---:|---|",
        ...(indexRows.length ? indexRows : ["| Not run | Not run | Not run | Not run | Not run | Not run |"]),
        "",
        "## Product listing throughput",
        "",
        "Endpoint: `/api/v1/products?page=1&limit=10&sort=newest`; Autocannon uses 10 connections for 30 seconds. Scenario C performs a successful warm-up request first.",
        "",
        "| Scenario | Status | Requests/sec | Average latency (ms) | P99 latency (ms) | Errors | Raw result |",
        "|---|---|---:|---:|---:|---:|---|",
        ...throughputRows,
        "",
        "## Inventory race test",
        "",
        `Target: exactly ${20} repetitions at each concurrency level (2, 10, 50, 100 buyers), one stock unit.`,
        "",
        "| Simultaneous buyers | Runs | Passed | Failed | Successful orders | Stock rejections | Final stock 0 | Oversell runs |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...(inventoryRows.length ? inventoryRows : ["| Not run | 0 | 0 | 0 | 0 | 0 | 0/0 | 0 |"]),
        "",
        "## Idempotency",
        "",
        `| Concurrent requests | Order count | Successful HTTP responses | Final stock | Status |`,
        `|---:|---:|---:|---:|---|`,
        `| ${idem?.concurrentRequests ?? "Not run"} | ${idem?.orderCount ?? "Not run"} | ${idem?.successfulResponses ?? "Not run"} | ${idem?.finalStock ?? "Not run"} | ${idem ? (idem.passed ? "PASS" : "FAIL") : "Not run"} |`,
        "",
        "## Suite stages",
        "",
        "| Stage | Status | Exit code | Error |",
        "|---|---|---:|---|",
        ...stageRows,
        "",
        "## Reproduce",
        "",
        "The benchmark scripts use the production-configured Upstash Redis REST client and credentials. MongoDB connects explicitly to `BENCHMARK_DB_NAME` using `BENCHMARK_MONGO_URI` as the cluster URI; the URI's database path is not used as the target database. Seeding replaces only the `products` collection in that dedicated database. The suite also creates temporary buyer/product/order fixtures there and cleans them up.",
        "",
        "From the repository root in PowerShell, with `BENCHMARK_MONGO_URI`, `BENCHMARK_DB_NAME`, Redis credentials, and application JWT secrets in `backend/.env`:",
        "",
        "```powershell",
        "npm --prefix backend run benchmark:all",
        "```",
        "",
        "The database name must contain `benchmark`. The suite exits non-zero if setup or any verification stage fails. Raw stage and per-scenario JSON files are saved under `benchmarks/results/`.",
        "",
        "## Claim reproduction summary",
        "",
        ...claims,
        "",
        `Raw suite output: [suite-${runId}.json](./results/suite-${runId}.json)`,
        ""
    ].join("\n");
};

const main = async () => {
    const stages = [];
    try {
        await validateBenchmarkEnvironment();
    } catch (error) {
        stages.push({
            id: "preflight",
            status: "failed",
            exitCode: 1,
            error: error.message
        });
        const seed = await readResult(`seed-${runId}.json`);
        const index = await readResult(`index-${runId}.json`);
        const throughput = await readResult(`throughput-${runId}.json`);
        const correctness = await readResult(`correctness-${runId}.json`);
        try {
            const { connectBenchmarkDatabase, mongoose } = await import("./benchmark-utils.js");
            const db = await connectBenchmarkDatabase();
            const finalProductCount = await db.collection("products").countDocuments();
            stages.push({
                id: "catalog-final-check",
                status: finalProductCount === 100_000 ? "passed" : "failed",
                exitCode: finalProductCount === 100_000 ? 0 : 1,
                error: finalProductCount === 100_000
                    ? ""
                    : `Expected 100000 products after cleanup; found ${finalProductCount}.`,
                productCount: finalProductCount
            });
            await mongoose.disconnect();
        } catch (error) {
            stages.push({
                id: "catalog-final-check",
                status: "failed",
                exitCode: 1,
                error: error.message
            });
        }
        const suite = {
            runId,
            status: "failed",
            databaseName: benchmarkDatabaseName,
            gitCommit,
            machine: machineInfo,
            stages,
            seed,
            index,
            throughput,
            correctness
        };
        await saveRawResult(`suite-${runId}.json`, suite);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(resolve(repoRoot, "benchmarks", "README.md"), buildReadme({
            stages, seed, index, throughput, correctness, suite
        }));
        process.exitCode = 1;
        return;
    }

    for (const script of scripts) {
        if (script.dependency && stages.some((stage) =>
            stage.id === script.dependency && stage.status !== "passed"
        )) {
            stages.push({ id: script.id, status: "skipped", exitCode: null });
            continue;
        }
        const result = await runScript(script.file);
        stages.push({
            id: script.id,
            status: result.exitCode === 0 ? "passed" : "failed",
            ...result
        });
    }

    const seed = await readResult(`seed-${runId}.json`);
    const index = await readResult(`index-${runId}.json`);
    const throughput = await readResult(`throughput-${runId}.json`);
    const correctness = await readResult(`correctness-${runId}.json`);
    const suite = {
        runId,
        timestamp: new Date().toISOString(),
        status: stages.every((stage) => stage.status === "passed") ? "passed" : "failed",
        databaseName: benchmarkDatabaseName,
        redisProvider: redisProvider(),
        gitCommit,
        machine: machineInfo,
        stages,
        seed,
        index,
        throughput,
        correctness,
        command: "npm --prefix backend run benchmark:all"
    };
    await saveRawResult(`suite-${runId}.json`, suite);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(repoRoot, "benchmarks", "README.md"), buildReadme({
        stages, seed, index, throughput, correctness, suite
    }));
    console.log(`Benchmark summary: benchmarks/README.md (${suite.status}).`);
    if (suite.status !== "passed") {
        process.exitCode = 1;
    }
};

main().catch(async (error) => {
    console.error(`Benchmark suite failed: ${error.stack || error.message}`);
    const failure = {
        runId,
        status: "failed",
        error: error.stack || error.message,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    try {
        await saveRawResult(`suite-${runId}.json`, failure);
    } catch (writeError) {
        console.error(`Could not save suite failure output: ${writeError.message}`);
    }
    process.exitCode = 1;
});
