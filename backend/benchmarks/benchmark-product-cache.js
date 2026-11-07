import autocannon from "autocannon";
import redisClient, { scanKeys } from "../src/config/redis.js";
import {
    benchmarkDatabaseName,
    connectBenchmarkDatabase,
    gitCommit,
    machineInfo,
    mongoose,
    runId,
    saveRawResult,
    startBenchmarkBackend,
    stopBenchmarkBackend,
    waitForBackend,
    getProductCacheStats
} from "./benchmark-utils.js";

const PRODUCT_COUNT = 100_000;
const DURATION_SECONDS = 30;
const CONNECTIONS = 10;
const PORT = Number(process.env.BENCHMARK_PORT || 5100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LISTING_PATH = "/api/v1/products?page=1&limit=10&sort=newest";
const LISTING_URL = new URL(LISTING_PATH, BASE_URL).toString();
const CACHE_NAMESPACE = `benchmark-${runId}`;
const CACHE_PATTERN = `products:${CACHE_NAMESPACE}:*`;
let interrupted = false;
const noteInterruption = () => {
    interrupted = true;
};
process.on("SIGINT", noteInterruption);
process.on("SIGTERM", noteInterruption);
const scenarios = [
    { id: "A", description: "No createdAt index; cache disabled", hasIndex: false, cacheEnabled: false },
    { id: "B", description: "createdAt index; cache disabled", hasIndex: true, cacheEnabled: false },
    { id: "C", description: "createdAt index; cache enabled and warmed", hasIndex: true, cacheEnabled: true }
];

const inspectPlan = (plan, stages = []) => {
    if (!plan || typeof plan !== "object") {
        return stages;
    }
    if (typeof plan.stage === "string") {
        stages.push(plan.stage);
    }
    for (const [key, value] of Object.entries(plan)) {
        if (key === "stage") {
            continue;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => inspectPlan(item, stages));
        } else if (value && typeof value === "object") {
            inspectPlan(value, stages);
        }
    }
    return stages;
};

const runIndexExplain = async (products, scenario) => {
    const explain = await products
        .find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .explain("executionStats");
    const winningStages = inspectPlan(explain.queryPlanner.winningPlan);
    const executionStages = inspectPlan(explain.executionStats.executionStages);
    const stages = [...new Set([...winningStages, ...executionStages])];
    return {
        scenario,
        query: { sort: { createdAt: -1 }, limit: 10 },
        totalDocsExamined: explain.executionStats.totalDocsExamined,
        totalKeysExamined: explain.executionStats.totalKeysExamined,
        executionTimeMillis: explain.executionStats.executionTimeMillis,
        winningPlanStages: winningStages,
        executionStages,
        classification: stages.includes("IXSCAN")
            ? "IXSCAN"
            : stages.includes("COLLSCAN") && stages.includes("SORT")
                ? "COLLSCAN+SORT"
                : stages.join("+") || "unknown",
        rawExplain: explain
    };
};

const fetchAndVerifyListing = async () => {
    const response = await fetch(LISTING_URL);
    if (!response.ok) {
        throw new Error(`Product listing returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (
        !Array.isArray(body.products) ||
        body.products.length !== 10 ||
        body.pagination?.totalProducts !== PRODUCT_COUNT
    ) {
        throw new Error(
            `Expected 10 products from a ${PRODUCT_COUNT}-product catalog; got ${body.pagination?.totalProducts ?? "invalid response"}.`
        );
    }
};

const runLoad = () => new Promise((resolveResult, rejectResult) => {
    const runner = autocannon({
        url: LISTING_URL,
        connections: CONNECTIONS,
        duration: DURATION_SECONDS,
        method: "GET"
    }, (error, result) => {
        if (error) {
            rejectResult(error);
            return;
        }
        resolveResult(result);
    });
    runner.on("error", rejectResult);
});

const dropCreatedAtIndexes = async (products) => {
    const indexes = (await products.indexes())
        .filter((index) => Object.hasOwn(index.key || {}, "createdAt"));
    for (const index of indexes) {
        await products.dropIndex(index.name);
    }
};

const restoreIndex = async (products, index) => {
    const options = { ...index };
    delete options.v;
    delete options.ns;
    delete options.key;
    await products.createIndex(index.key, options);
};

const main = async () => {
    const db = await connectBenchmarkDatabase();
    const products = db.collection("products");
    const productCount = await products.countDocuments();
    if (productCount !== PRODUCT_COUNT) {
        await mongoose.disconnect();
        throw new Error(`Expected exactly ${PRODUCT_COUNT} products; found ${productCount}.`);
    }

    const originalIndexes = (await products.indexes())
        .filter((index) => Object.hasOwn(index.key || {}, "createdAt"));
    const indexResults = [];
    const indexFailures = [];
    const performanceResults = [];
    const scenarioFailures = [];
    let restoration = "not attempted";

    try {
        for (const scenario of scenarios) {
            if (interrupted) {
                scenarioFailures.push({
                    scenario: scenario.id,
                    error: "Benchmark interrupted; restoring the original index configuration."
                });
                break;
            }
            let backend;
            try {
                await dropCreatedAtIndexes(products);
                if (scenario.hasIndex) {
                    await products.createIndex({ createdAt: -1 });
                }
                const indexes = (await products.indexes())
                    .filter((index) => Object.hasOwn(index.key || {}, "createdAt"));
                if (indexes.length !== (scenario.hasIndex ? 1 : 0)) {
                    throw new Error(`Scenario ${scenario.id} index setup did not match its specification.`);
                }
                if (scenario.id !== "C") {
                    const indexResult = await runIndexExplain(products, scenario.id);
                    indexResult.expectedClassification = scenario.hasIndex
                        ? "IXSCAN"
                        : "COLLSCAN+SORT";
                    indexResult.passed =
                        indexResult.classification === indexResult.expectedClassification;
                    indexResults.push(indexResult);
                    if (!indexResult.passed) {
                        indexFailures.push({
                            scenario: scenario.id,
                            expected: indexResult.expectedClassification,
                            actual: indexResult.classification
                        });
                    }
                }

                const oldKeys = await scanKeys(CACHE_PATTERN);
                if (oldKeys.length > 0) {
                    await redisClient.del(...oldKeys);
                }

                backend = startBenchmarkBackend({
                    port: PORT,
                    disableProductCache: !scenario.cacheEnabled,
                    cacheNamespace: CACHE_NAMESPACE
                });
                await waitForBackend(backend, BASE_URL);
                await fetchAndVerifyListing();
                const cacheBeforeLoad = await getProductCacheStats(BASE_URL);
                if (
                    scenario.cacheEnabled &&
                    (cacheBeforeLoad.hits !== 0 || cacheBeforeLoad.misses !== 1)
                ) {
                    throw new Error("Warm-up did not produce exactly one cache miss.");
                }
                if (
                    !scenario.cacheEnabled &&
                    (cacheBeforeLoad.hits !== 0 || cacheBeforeLoad.misses !== 0)
                ) {
                    throw new Error("Cache-disabled listing accessed the product cache.");
                }

                const autocannonResult = await runLoad();
                if (interrupted) {
                    throw new Error("Benchmark interrupted; restoring the original index configuration.");
                }
                const cacheAfterLoad = await getProductCacheStats(BASE_URL);
                const result = {
                    runId,
                    timestamp: new Date().toISOString(),
                    status: "completed",
                    scenario,
                    endpoint: LISTING_URL,
                    databaseName: benchmarkDatabaseName,
                    dataset: { productCount, collection: "products" },
                    load: {
                        connections: CONNECTIONS,
                        durationSeconds: DURATION_SECONDS,
                        requestsPerSecond: autocannonResult.requests.average,
                        averageLatencyMs: autocannonResult.latency.average,
                        p99LatencyMs: autocannonResult.latency.p99,
                        errors: autocannonResult.errors,
                        non2xx: autocannonResult.non2xx
                    },
                    passed: autocannonResult.errors === 0 && autocannonResult.non2xx === 0,
                    cache: {
                        enabled: scenario.cacheEnabled,
                        warmupHits: cacheBeforeLoad.hits,
                        warmupMisses: cacheBeforeLoad.misses,
                        hitsDuringLoad: cacheAfterLoad.hits - cacheBeforeLoad.hits,
                        missesDuringLoad: cacheAfterLoad.misses - cacheBeforeLoad.misses,
                        namespace: CACHE_NAMESPACE
                    },
                    indexNames: indexes.map((index) => index.name),
                    gitCommit,
                    machine: machineInfo,
                    command: "npm --prefix backend run benchmark:all",
                    rawAutocannon: autocannonResult
                };
                performanceResults.push(result);
                console.log(
                    `Throughput ${scenario.id}: ${result.load.requestsPerSecond} requests/sec, ` +
                    `${result.load.averageLatencyMs} ms average, ${result.load.p99LatencyMs} ms p99, ` +
                    `${result.load.errors} errors.`
                );
                if (
                    scenario.cacheEnabled &&
                    result.cache.missesDuringLoad !== 0
                ) {
                    result.status = "failed";
                    result.failure = "Warmed load recorded cache misses.";
                    scenarioFailures.push({ scenario: scenario.id, error: result.failure });
                }
                if (!result.passed) {
                    result.status = "failed";
                    result.failure = "Autocannon reported errors or non-2xx responses.";
                    scenarioFailures.push({ scenario: scenario.id, error: result.failure });
                }
                await saveRawResult(`throughput-${runId}-${scenario.id}.json`, result);
            } catch (error) {
                const backendOutput = backend?.getOutput();
                const details = backendOutput
                    ? `${error.stack || error.message}\nBackend output:\n${backendOutput}`
                    : error.stack || error.message;
                scenarioFailures.push({ scenario: scenario.id, error: details });
                const failure = {
                    runId,
                    timestamp: new Date().toISOString(),
                    status: "failed",
                    scenario,
                    endpoint: LISTING_URL,
                    databaseName: benchmarkDatabaseName,
                    gitCommit,
                    machine: machineInfo,
                    error: details
                };
                await saveRawResult(`throughput-${runId}-${scenario.id}.json`, failure);
                console.error(`Throughput ${scenario.id} failed: ${error.message}`);
            } finally {
                if (backend) {
                    await stopBenchmarkBackend(backend.child);
                }
            }
        }
    } finally {
        try {
            await dropCreatedAtIndexes(products);
            for (const index of originalIndexes) {
                await restoreIndex(products, index);
            }
            restoration = `restored ${originalIndexes.length} original createdAt index(es)`;
        } catch (error) {
            restoration = `failed: ${error.message}`;
            scenarioFailures.push({ scenario: "index restoration", error: error.message });
        }

        try {
            const keys = await scanKeys(CACHE_PATTERN);
            if (keys.length > 0) {
                await redisClient.del(...keys);
            }
        } catch (error) {
            scenarioFailures.push({ scenario: "cache cleanup", error: error.message });
        }
    }

    const indexRecord = {
        runId,
        timestamp: new Date().toISOString(),
        databaseName: benchmarkDatabaseName,
        dataset: { productCount },
        results: indexResults,
        validationFailures: indexFailures,
        restoration,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    const throughputRecord = {
        runId,
        timestamp: new Date().toISOString(),
        results: performanceResults,
        failures: scenarioFailures,
        restoration,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    await saveRawResult(`index-${runId}.json`, indexRecord);
    await saveRawResult(`throughput-${runId}.json`, throughputRecord);
    await mongoose.disconnect();
    process.off("SIGINT", noteInterruption);
    process.off("SIGTERM", noteInterruption);
    if (
        scenarioFailures.length > 0 ||
        indexFailures.length > 0 ||
        performanceResults.length !== scenarios.length
    ) {
        process.exitCode = 1;
    }
};

main().catch(async (error) => {
    console.error(`Product/index benchmark failed: ${error.stack || error.message}`);
    const failure = {
        runId,
        status: "failed",
        error: error.stack || error.message,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    try {
        await saveRawResult(`product-cache-${runId}.json`, failure);
    } catch (writeError) {
        console.error(`Could not save product benchmark failure output: ${writeError.message}`);
    }
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    process.exitCode = 1;
});
