import { randomUUID } from "node:crypto";
import Cart from "../src/models/cart.model.js";
import Order from "../src/models/order.model.js";
import Product from "../src/models/product.model.js";
import User from "../src/models/user.model.js";
import redisClient, { scanKeys } from "../src/config/redis.js";
import { generateAccessToken } from "../src/utils/token.js";
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
    waitForBackend
} from "./benchmark-utils.js";

const PORT = Number(process.env.BENCHMARK_ORDER_PORT || 5101);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const concurrencyLevels = [2, 10, 50, 100];
const repetitions = 20;
const maxBuyers = Math.max(...concurrencyLevels);
const timeoutMs = 30_000;
let activeBackend;

const createFixtureProduct = async (name, stock) => Product.create({
    name,
    description: "Temporary isolated benchmark fixture.",
    price: 1,
    images: [],
    category: "Benchmark",
    stock,
    brand: "MAREN BENCHMARK",
    isActive: true
});

const createFixtureUsers = async () => {
    const fixtureId = randomUUID();
    const records = Array.from({ length: maxBuyers }, (_, index) => ({
        name: `Benchmark Buyer ${index + 1}`,
        email: `benchmark-${runId}-${fixtureId}-${index + 1}@example.invalid`,
        age: 30,
        gender: "not to say",
        password: randomUUID(),
        role: "user"
    }));
    const users = await User.insertMany(records);
    return {
        users,
        tokens: users.map((user) => generateAccessToken(user._id.toString(), "user"))
    };
};

const setBuyerCarts = async (users, productId) => {
    await Cart.bulkWrite(users.map((user) => ({
        updateOne: {
            filter: { user: user._id },
            update: { $set: { items: [{ product: productId, quantity: 1 }] } },
            upsert: true
        }
    })));
};

const sendPurchase = async (token, addressLine, idempotencyKey) => {
    try {
        const response = await fetch(`${BASE_URL}/api/v1/orders`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${token}`,
                "Idempotency-Key": idempotencyKey
            },
            body: JSON.stringify({
                shippingAddress: {
                    fullName: "Benchmark Buyer",
                    phone: "9876543210",
                    addressLine,
                    pincode: "440001",
                    city: "Nagpur",
                    state: "Maharashtra"
                }
            }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await response.text();
        let body = text;
        try {
            body = JSON.parse(text);
        } catch {
            // Preserve a non-JSON response for the raw benchmark record.
        }
        return { status: response.status, body };
    } catch (error) {
        return { status: "NETWORK_ERROR", error: error.message };
    }
};

const countOrdersForRace = (userIds, productId, addressLine) =>
    Order.countDocuments({
        user: { $in: userIds },
        "shippingAddress.addressLine": addressLine,
        items: { $elemMatch: { product: productId, quantity: 1 } }
    });

const runInventoryRace = async (users, tokens, concurrency, repetition) => {
    const runKey = randomUUID();
    const addressLine = `benchmark-inventory-${runId}-${concurrency}-${repetition}-${runKey}`;
    const product = await createFixtureProduct(
        `Benchmark Inventory ${runId} ${concurrency} ${repetition} ${runKey}`,
        1
    );
    const buyers = users.slice(0, concurrency);
    const buyerTokens = tokens.slice(0, concurrency);
    const keys = buyerTokens.map(() => randomUUID());
    try {
        await setBuyerCarts(buyers, product._id);
        const responses = await Promise.all(
            buyerTokens.map((token, index) => sendPurchase(token, addressLine, keys[index]))
        );
        const successfulOrders = responses.filter((response) => response.status === 201).length;
        const rejectedOrders = responses.filter((response) =>
            response.status === 400 &&
            /insufficient stock/i.test(response.body?.message || "")
        ).length;
        const unexpectedResponses = responses.filter((response) =>
            response.status !== 201 &&
            !(
                response.status === 400 &&
                /insufficient stock/i.test(response.body?.message || "")
            )
        );
        const createdOrders = await countOrdersForRace(
            buyers.map((user) => user._id),
            product._id,
            addressLine
        );
        const finalProduct = await Product.findById(product._id).select("stock").lean();
        const finalStock = finalProduct?.stock ?? null;
        const passed =
            successfulOrders === 1 &&
            rejectedOrders === concurrency - 1 &&
            createdOrders === 1 &&
            finalStock === 0 &&
            unexpectedResponses.length === 0;
        return {
            concurrency,
            repetition,
            productId: product._id.toString(),
            successfulOrders,
            rejectedOrders,
            createdOrders,
            finalStock,
            unexpectedResponses,
            statuses: responses.map((response) => response.status),
            passed
        };
    } finally {
        await Order.deleteMany({ "shippingAddress.addressLine": addressLine });
        await Cart.deleteMany({ user: { $in: buyers.map((user) => user._id) } });
        await Product.deleteOne({ _id: product._id });
        const redisKeys = keys.map((key, index) =>
            `idempotency:order:${buyers[index]._id}:${key}`
        );
        if (redisKeys.length > 0) {
            await redisClient.del(...redisKeys);
        }
    }
};

const runIdempotencyTest = async (user, token) => {
    const key = randomUUID();
    const addressLine = `benchmark-idempotency-${runId}-${randomUUID()}`;
    const product = await createFixtureProduct(`Benchmark Idempotency ${runId} ${randomUUID()}`, 1);
    try {
        await setBuyerCarts([user], product._id);
        const responses = await Promise.all(
            Array.from({ length: 50 }, () => sendPurchase(token, addressLine, key))
        );
        const orderCount = await countOrdersForRace([user._id], product._id, addressLine);
        const finalProduct = await Product.findById(product._id).select("stock").lean();
        return {
            concurrentRequests: responses.length,
            sameIdempotencyKey: true,
            idempotencyKey: key,
            orderCount,
            successfulResponses: responses.filter((response) => response.status === 201).length,
            responseStatusCounts: responses.reduce((counts, response) => {
                const status = String(response.status);
                counts[status] = (counts[status] || 0) + 1;
                return counts;
            }, {}),
            finalStock: finalProduct?.stock ?? null,
            passed: orderCount === 1 && finalProduct?.stock === 0
        };
    } finally {
        await Order.deleteMany({ "shippingAddress.addressLine": addressLine });
        await Cart.deleteMany({ user: user._id });
        await Product.deleteOne({ _id: product._id });
        await redisClient.del(`idempotency:order:${user._id}:${key}`);
    }
};

const waitForCatalogReady = async () => {
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(
                new URL("/api/v1/products?page=1&limit=10&sort=newest", BASE_URL)
            );
            if (response.ok) {
                const body = await response.json();
                if (
                    Array.isArray(body.products) &&
                    body.pagination?.totalProducts === 100_000
                ) {
                    return;
                }
                throw new Error("Benchmark product endpoint did not return the seeded catalog.");
            }
            lastError = new Error(`Product endpoint returned HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw new Error(`Benchmark backend catalog readiness timed out: ${lastError?.message || "unknown error"}`);
};

const main = async () => {
    await connectBenchmarkDatabase();
    const fixture = await createFixtureUsers();
    const records = [];
    let backend;
    try {
        backend = startBenchmarkBackend({
            port: PORT,
            disableProductCache: false,
            cacheNamespace: `benchmark-orders-${runId}`
        });
        activeBackend = backend;
        await waitForBackend(backend, BASE_URL);
        await waitForCatalogReady();

        for (const concurrency of concurrencyLevels) {
            for (let repetition = 1; repetition <= repetitions; repetition++) {
                try {
                    const record = await runInventoryRace(
                        fixture.users,
                        fixture.tokens,
                        concurrency,
                        repetition
                    );
                    records.push(record);
                    await saveRawResult(
                        `inventory-${runId}-${concurrency}-${repetition}.json`,
                        record
                    );
                    console.log(
                        `Inventory ${concurrency} buyers run ${repetition}/${repetitions}: ` +
                        `${record.successfulOrders} successful, ${record.rejectedOrders} rejected, ` +
                        `stock ${record.finalStock}; ${record.passed ? "PASS" : "FAIL"}`
                    );
                } catch (error) {
                    records.push({
                        concurrency,
                        repetition,
                        passed: false,
                        error: error.stack || error.message
                    });
                    await saveRawResult(
                        `inventory-${runId}-${concurrency}-${repetition}.json`,
                        records.at(-1)
                    );
                    console.error(`Inventory ${concurrency} run ${repetition} failed: ${error.message}`);
                }
            }
        }

        let idempotency;
        try {
            idempotency = await runIdempotencyTest(fixture.users[0], fixture.tokens[0]);
        } catch (error) {
            idempotency = {
                passed: false,
                error: error.stack || error.message
            };
        }
        await saveRawResult(`idempotency-${runId}.json`, idempotency);

        const result = {
            runId,
            timestamp: new Date().toISOString(),
            databaseName: benchmarkDatabaseName,
            inventory: {
                concurrencyLevels,
                repetitionsPerLevel: repetitions,
                results: records,
                summary: concurrencyLevels.map((concurrency) => {
                    const runs = records.filter((record) => record.concurrency === concurrency);
                    return {
                        concurrency,
                        runs: runs.length,
                        passed: runs.filter((record) => record.passed).length,
                        failed: runs.filter((record) => !record.passed).length,
                        successfulOrders: runs.reduce((sum, record) => sum + (record.successfulOrders || 0), 0),
                        rejectedOrders: runs.reduce((sum, record) => sum + (record.rejectedOrders || 0), 0),
                        oversellRuns: runs.filter((record) =>
                            record.finalStock !== null && record.finalStock < 0
                        ).length,
                        finalStockZeroRuns: runs.filter((record) => record.finalStock === 0).length
                    };
                })
            },
            idempotency,
            gitCommit,
            machine: machineInfo,
            command: "npm --prefix backend run benchmark:all"
        };
        await saveRawResult(`correctness-${runId}.json`, result);
        if (records.some((record) => !record.passed) || !idempotency.passed) {
            process.exitCode = 1;
        }
    } finally {
        if (backend) {
            await stopBenchmarkBackend(backend.child);
        }
        await Order.deleteMany({ user: { $in: fixture.users.map((user) => user._id) } });
        await Cart.deleteMany({ user: { $in: fixture.users.map((user) => user._id) } });
        await User.deleteMany({ _id: { $in: fixture.users.map((user) => user._id) } });
        const cacheKeys = await scanKeys(`products:benchmark-orders-${runId}:*`);
        if (cacheKeys.length > 0) {
            await redisClient.del(...cacheKeys);
        }
        await mongoose.disconnect();
    }
};

main().catch(async (error) => {
    const backendOutput = activeBackend?.getOutput();
    const details = backendOutput
        ? `${error.stack || error.message}\nBackend output:\n${backendOutput}`
        : error.stack || error.message;
    console.error(`Order correctness benchmark failed: ${error.message}`);
    const failure = {
        runId,
        status: "failed",
        error: details,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    try {
        await saveRawResult(`correctness-${runId}.json`, failure);
    } catch (writeError) {
        console.error(`Could not save correctness failure output: ${writeError.message}`);
    }
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    process.exitCode = 1;
});
