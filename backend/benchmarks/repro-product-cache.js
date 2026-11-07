import { execFileSync, spawn } from "node:child_process";
import { cpus, freemem, hostname, platform, release, totalmem, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import autocannon from "autocannon";
import mongoose from "mongoose";
import redisClient, { scanKeys } from "../src/config/redis.js";
import { REDIS_ENABLED, REDIS_URL } from "../src/config/env.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const resultsDir = resolve(repoRoot, "benchmarks", "results");
const databaseUri = process.env.BENCHMARK_MONGO_URI;
const expectedDatabaseName = process.env.BENCHMARK_DB_NAME;
const productCountExpected = 100_000;
const duration = 30;
const connections = 10;
const listingPath = "/api/v1/products?page=1&limit=10&sort=newest";
const benchmarkTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const cacheNamespace = `benchmark-${benchmarkTimestamp}`;
const cachePattern = `products:${cacheNamespace}:*`;
const port = Number(process.env.BENCHMARK_PORT || 5100);
const baseUrl = `http://127.0.0.1:${port}`;
const listingUrl = new URL(listingPath, baseUrl).toString();
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
}).trim();
const command = "npm --prefix backend run benchmark:products";
let interrupted = false;
const handleInterruption = () => {
    interrupted = true;
};
process.on("SIGINT", handleInterruption);
process.on("SIGTERM", handleInterruption);

const machineInfo = {
    hostname: hostname(),
    platform: `${platform()} ${release()}`,
    architecture: arch(),
    node: process.version,
    cpu: cpus()[0]?.model || "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
};

const scenarios = [
    {
        id: "A",
        description: "No createdAt index, product cache disabled",
        hasIndex: false,
        cacheEnabled: false
    },
    {
        id: "B",
        description: "createdAt index present, product cache disabled",
        hasIndex: true,
        cacheEnabled: false
    },
    {
        id: "C",
        description: "createdAt index present, product cache enabled and warmed",
        hasIndex: true,
        cacheEnabled: true
    }
];

const validateConfiguration = async () => {
    if (!databaseUri || !expectedDatabaseName) {
        throw new Error(
            "Set BENCHMARK_MONGO_URI and BENCHMARK_DB_NAME to an isolated benchmark database."
        );
    }
    if (!expectedDatabaseName.toLowerCase().includes("benchmark")) {
        throw new Error("BENCHMARK_DB_NAME must contain 'benchmark'; refusing index changes.");
    }
    if (!REDIS_ENABLED || !REDIS_URL || new URL(REDIS_URL).protocol !== "https:") {
        throw new Error("The production-compatible Upstash Redis REST configuration must be enabled.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("BENCHMARK_PORT must be a valid TCP port.");
    }

    try {
        await mongoose.connect(databaseUri);
        const actualDatabaseName = mongoose.connection.db.databaseName;
        if (actualDatabaseName !== expectedDatabaseName) {
            throw new Error(
                `BENCHMARK_DB_NAME does not match the MongoDB URI database (${actualDatabaseName}).`
            );
        }

        const count = await mongoose.connection.db.collection("products").countDocuments();
        if (count !== productCountExpected) {
            throw new Error(
                `Expected exactly ${productCountExpected} products in ${actualDatabaseName}; found ${count}.`
            );
        }
        if ((await redisClient.ping()).toUpperCase() !== "PONG") {
            throw new Error("Configured Upstash Redis REST service did not return PONG.");
        }
    } catch (error) {
        await mongoose.disconnect();
        throw error;
    }
};

const getCreatedAtIndexes = async () => {
    const indexes = await mongoose.connection.db.collection("products").indexes();
    return indexes.filter((index) => Object.hasOwn(index.key || {}, "createdAt"));
};

const dropCreatedAtIndexes = async () => {
    const collection = mongoose.connection.db.collection("products");
    const indexes = await getCreatedAtIndexes();
    for (const index of indexes) {
        await collection.dropIndex(index.name);
    }
};

const restoreIndex = async (index) => {
    const options = { ...index };
    delete options.v;
    delete options.ns;
    delete options.key;
    await mongoose.connection.db.collection("products").createIndex(index.key, options);
};

const getCacheStats = async () => {
    const response = await fetch(new URL("/api/v1/products/cache-stats", baseUrl));
    if (!response.ok) {
        throw new Error(`Cache stats endpoint returned HTTP ${response.status}`);
    }
    return response.json();
};

const fetchListing = async () => {
    const response = await fetch(listingUrl);
    if (!response.ok) {
        throw new Error(`Listing endpoint returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (
        !Array.isArray(body.products) ||
        body.products.length !== 10 ||
        body.pagination?.totalProducts !== productCountExpected
    ) {
        throw new Error("Listing response did not contain 10 products from the verified 100K catalog.");
    }
};

const startBackend = (cacheEnabled) => {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: resolve(repoRoot, "backend"),
        env: {
            ...process.env,
            MONGO_URI: databaseUri,
            PORT: String(port),
            DISABLE_PRODUCT_CACHE: String(!cacheEnabled),
            PRODUCT_CACHE_NAMESPACE: cacheNamespace
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
    return { child, getOutput: () => output };
};

const waitForBackend = async ({ child, getOutput }) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Benchmark backend exited early.\n${getOutput()}`);
        }
        try {
            const response = await fetch(new URL("/api/v1/health", baseUrl));
            if (response.ok) {
                return;
            }
        } catch {
            await delay(500);
        }
    }
    child.kill();
    throw new Error(`Timed out waiting for benchmark backend.\n${getOutput()}`);
};

const stopBackend = async (child) => {
    if (child.exitCode !== null) {
        return;
    }
    child.kill();
    await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(10_000).then(() => {
            if (child.exitCode === null) {
                throw new Error("Benchmark backend did not stop after SIGTERM.");
            }
        })
    ]);
};

const runAutocannon = () => new Promise((resolveResult, rejectResult) => {
    const instance = autocannon(
        {
            url: listingUrl,
            connections,
            duration,
            method: "GET"
        },
        (error, result) => {
            if (error) {
                rejectResult(error);
                return;
            }
            resolveResult(result);
        }
    );
    instance.on("error", rejectResult);
});

const saveResult = async (scenario, result, cacheStats, indexStatus) => {
    const record = {
        timestamp: new Date().toISOString(),
        scenario,
        endpoint: listingUrl,
        databaseName: expectedDatabaseName,
        dataset: { collection: "products", expectedCount: productCountExpected },
        load: { connections, durationSeconds: duration },
        indexStatus,
        cache: {
            enabled: scenario.cacheEnabled,
            namespace: cacheNamespace,
            hitsDuringLoad: cacheStats.hitsDuringLoad,
            missesDuringLoad: cacheStats.missesDuringLoad
        },
        gitCommit,
        machine: machineInfo,
        command,
        autocannon: result
    };
    const filename = `products-${benchmarkTimestamp}-${scenario.id}.json`;
    const filepath = resolve(resultsDir, filename);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(filepath, `${JSON.stringify(record, null, 2)}\n`);
    return { filename, filepath, record };
};

const formatNumber = (value) => Number(value).toFixed(2);

const writeBenchmarkReadme = async (records, restorationMessage) => {
    const rows = records.map(({ filename, record }) => {
        const result = record.autocannon;
        return `| ${record.scenario.id} | ${record.scenario.description} | ${formatNumber(result.requests.average)} | ${formatNumber(result.latency.average)} | ${formatNumber(result.latency.p99)} | ${result.errors} | [${filename}](./results/${filename}) |`;
    });
    const machine = records[0]?.record.machine || machineInfo;
    const readme = [
        "# Reproducible product-list benchmark",
        "",
        `Run timestamp: ${benchmarkTimestamp}`,
        "",
        "Each scenario uses the same isolated MongoDB database containing exactly 100,000 products, the same endpoint, 10 Autocannon connections, and 30 seconds. Scenario C is warmed with one successful listing request before its load test. Raw Autocannon JSON is saved alongside each row.",
        "",
        "Redis: the backend's production-compatible Upstash Redis REST client/configuration (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). The run uses a unique `PRODUCT_CACHE_NAMESPACE` so it does not overwrite or clear production product-list keys.",
        "",
        "| Scenario | Configuration | Requests/sec | Average latency (ms) | P99 latency (ms) | Errors | Raw output |",
        "|---|---|---:|---:|---:|---:|---|",
        ...rows,
        "",
        `Git commit: \`${gitCommit}\``,
        "",
        "## Machine",
        "",
        `- Hostname: ${machine.hostname}`,
        `- OS: ${machine.platform}`,
        `- Architecture: ${machine.architecture}`,
        `- Node.js: ${machine.node}`,
        `- CPU: ${machine.cpu} (${machine.cpuCount} logical CPUs)`,
        `- Memory: ${machine.totalMemoryBytes} bytes total; ${machine.freeMemoryBytesAtStart} bytes free at start`,
        "",
        "## Exact command",
        "",
        "From the repository root, with the benchmark environment variables configured:",
        "",
        "```powershell",
        '$env:BENCHMARK_MONGO_URI = "<isolated benchmark MongoDB URI>"',
        '$env:BENCHMARK_DB_NAME = "<database name containing benchmark>"',
        "npm --prefix backend run benchmark:products",
        "```",
        "",
        "The MongoDB URI and database name must identify the same isolated database. The script refuses to run unless its name contains `benchmark`, verifies an exact 100,000-product catalog, records and restores any pre-existing `createdAt` indexes, and uses the configured Upstash credentials without printing them.",
        "",
        `Index restoration: ${restorationMessage}`,
        ""
    ].join("\n");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(repoRoot, "benchmarks", "README.md"), readme);
};

const main = async () => {
    const { mkdir } = await import("node:fs/promises");
    await validateConfiguration();
    await mkdir(resultsDir, { recursive: true });

    const collection = mongoose.connection.db.collection("products");
    const originalIndexes = await getCreatedAtIndexes();
    const records = [];
    let restorationMessage = "not attempted";
    let primaryError;

    try {
        for (const scenario of scenarios) {
            if (interrupted) {
                throw new Error("Benchmark interrupted; restoring the original indexes.");
            }
            await dropCreatedAtIndexes();
            if (scenario.hasIndex) {
                await collection.createIndex({ createdAt: -1 });
            }

            const currentIndexes = await getCreatedAtIndexes();
            if (currentIndexes.length !== (scenario.hasIndex ? 1 : 0)) {
                throw new Error(`Scenario ${scenario.id} index setup did not match its specification.`);
            }

            const staleKeys = await scanKeys(cachePattern);
            if (staleKeys.length > 0) {
                await redisClient.del(...staleKeys);
            }

            const backend = startBackend(scenario.cacheEnabled);
            try {
                await waitForBackend(backend);
                await fetchListing();
                const beforeLoad = await getCacheStats();
                if (
                    !scenario.cacheEnabled &&
                    (beforeLoad.hits !== 0 || beforeLoad.misses !== 0)
                ) {
                    throw new Error(`Scenario ${scenario.id} unexpectedly accessed product cache.`);
                }
                if (
                    scenario.cacheEnabled &&
                    (beforeLoad.hits !== 0 || beforeLoad.misses !== 1)
                ) {
                    throw new Error(`Scenario ${scenario.id} warm-up did not produce exactly one cache miss.`);
                }
                const result = await runAutocannon();
                const afterLoad = await getCacheStats();
                const cacheStats = {
                    hitsDuringLoad: afterLoad.hits - beforeLoad.hits,
                    missesDuringLoad: afterLoad.misses - beforeLoad.misses
                };
                const saved = await saveResult(
                    scenario,
                    result,
                    cacheStats,
                    currentIndexes.map((index) => index.name)
                );
                records.push(saved);
                console.log(
                    `Scenario ${scenario.id}: ${result.requests.average} req/s; ${result.latency.average} ms average; ${result.latency.p99} ms p99; ${result.errors} errors.`
                );

                if (interrupted) {
                    throw new Error("Benchmark interrupted; restoring the original indexes.");
                }
                if (scenario.cacheEnabled && cacheStats.missesDuringLoad !== 0) {
                    throw new Error(`Scenario ${scenario.id} had cache misses during the warmed load.`);
                }
            } finally {
                await stopBackend(backend.child);
            }
        }
    } catch (error) {
        primaryError = error;
    } finally {
        try {
            await dropCreatedAtIndexes();
            for (const index of originalIndexes) {
                await restoreIndex(index);
            }
            restorationMessage = `restored ${originalIndexes.length} original createdAt index(es)`;
        } catch (error) {
            restorationMessage = `FAILED: ${error.message}`;
            primaryError = primaryError || error;
        }
        try {
            const benchmarkKeys = await scanKeys(cachePattern);
            if (benchmarkKeys.length > 0) {
                await redisClient.del(...benchmarkKeys);
            }
        } catch (error) {
            primaryError = primaryError || error;
        }
        if (records.length > 0) {
            await writeBenchmarkReadme(records, restorationMessage);
        }
        await mongoose.disconnect();
    }
    process.off("SIGINT", handleInterruption);
    process.off("SIGTERM", handleInterruption);

    if (primaryError) {
        throw primaryError;
    }
};

main().catch((error) => {
    console.error(`Product benchmark failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
