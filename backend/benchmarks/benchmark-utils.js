import { execFileSync, spawn } from "node:child_process";
import { cpus, freemem, platform, release, totalmem, arch } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { REDIS_ENABLED, REDIS_URL } from "../src/config/env.js";
import redisClient from "../src/config/redis.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const resultsDir = resolve(repoRoot, "benchmarks", "results");
export const runId = process.env.BENCHMARK_RUN_ID ||
    new Date().toISOString().replace(/[:.]/g, "-");
export const benchmarkDatabaseName = process.env.BENCHMARK_DB_NAME;
const benchmarkMongoUri = process.env.BENCHMARK_MONGO_URI;

export const machineInfo = {
    platform: `${platform()} ${release()}`,
    architecture: arch(),
    node: process.version,
    cpu: cpus()[0]?.model || "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
};

export const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
}).trim();

export const redisProvider = () => {
    if (!REDIS_ENABLED) {
        return "disabled";
    }
    return REDIS_URL && new URL(REDIS_URL).protocol === "https:"
        ? "Upstash Redis REST"
        : "local Redis";
};

export const validateBenchmarkEnvironment = async () => {
    if (!benchmarkMongoUri || !benchmarkDatabaseName) {
        throw new Error(
            "Set BENCHMARK_MONGO_URI and BENCHMARK_DB_NAME to a dedicated benchmark database."
        );
    }
    if (!benchmarkDatabaseName.toLowerCase().includes("benchmark")) {
        throw new Error("BENCHMARK_DB_NAME must contain 'benchmark'; refusing benchmark database writes.");
    }
    if (!REDIS_ENABLED || !REDIS_URL) {
        throw new Error("Redis must be enabled and configured for the benchmark suite.");
    }
    if ((await redisClient.ping()).toUpperCase() !== "PONG") {
        throw new Error("Configured Redis service did not return PONG.");
    }
};

export const connectBenchmarkDatabase = async () => {
    await validateBenchmarkEnvironment();
    await mongoose.connect(benchmarkMongoUri, { dbName: benchmarkDatabaseName });
    if (mongoose.connection.db.databaseName !== benchmarkDatabaseName) {
        await mongoose.disconnect();
        throw new Error("MongoDB connected to a database other than BENCHMARK_DB_NAME.");
    }
    return mongoose.connection.db;
};

export const benchmarkMongoConnectionString = () => {
    if (!benchmarkMongoUri || !benchmarkDatabaseName) {
        throw new Error("Benchmark MongoDB settings are missing.");
    }
    const uri = new URL(benchmarkMongoUri);
    uri.pathname = `/${encodeURIComponent(benchmarkDatabaseName)}`;
    return uri.toString();
};

export const saveRawResult = async (filename, record) => {
    await mkdir(resultsDir, { recursive: true });
    const filepath = resolve(resultsDir, filename);
    await writeFile(filepath, `${JSON.stringify(record, null, 2)}\n`);
    return filepath;
};

export const startBenchmarkBackend = ({ port, disableProductCache, cacheNamespace = "" }) => {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: resolve(repoRoot, "backend"),
        env: {
            ...process.env,
            MONGO_URI: benchmarkMongoConnectionString(),
            PORT: String(port),
            DISABLE_PRODUCT_CACHE: String(disableProductCache),
            PRODUCT_CACHE_NAMESPACE: cacheNamespace
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const getOutput = () => {
        let safeOutput = output;
        for (const secret of [
            process.env.BENCHMARK_MONGO_URI,
            benchmarkMongoConnectionString(),
            process.env.UPSTASH_REDIS_REST_URL,
            process.env.UPSTASH_REDIS_REST_TOKEN
        ]) {
            if (secret) {
                safeOutput = safeOutput.replaceAll(secret, "[redacted]");
            }
        }
        return safeOutput;
    };
    child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-20_000);
    });
    return { child, getOutput };
};

export const waitForBackend = async ({ child, getOutput }, baseUrl) => {
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
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        }
    }
    child.kill();
    throw new Error(`Timed out waiting for benchmark backend.\n${getOutput()}`);
};

export const stopBenchmarkBackend = async (child) => {
    if (child.exitCode !== null) {
        return;
    }
    child.kill();
    let timeout;
    try {
        await Promise.race([
            new Promise((resolveExit) => child.once("exit", resolveExit)),
            new Promise((_, rejectTimeout) => {
                timeout = setTimeout(
                    () => rejectTimeout(new Error("Benchmark backend did not stop after SIGTERM.")),
                    10_000
                );
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
};

export const getProductCacheStats = async (baseUrl) => {
    const response = await fetch(new URL("/api/v1/products/cache-stats", baseUrl));
    if (!response.ok) {
        throw new Error(`Product cache stats returned HTTP ${response.status}`);
    }
    return response.json();
};

export { mongoose };
