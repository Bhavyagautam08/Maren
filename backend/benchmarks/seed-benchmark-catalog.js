import {
    connectBenchmarkDatabase,
    gitCommit,
    machineInfo,
    mongoose,
    runId,
    saveRawResult
} from "./benchmark-utils.js";

const PRODUCT_COUNT = 100_000;
const BATCH_SIZE = 1_000;
const SEED = 0x4d415245;
const categories = ["Outerwear", "Dresses", "Sets", "Bottoms", "Tops", "Footwear", "Accessories"];
const brands = ["MAREN", "MAREN STUDIO", "MAREN EDIT", "MAREN ATELIER"];
const descriptions = [
    "A refined silhouette with considered detailing and a contemporary finish.",
    "Designed with versatile proportions and carefully selected materials.",
    "An elevated wardrobe essential with thoughtful construction."
];

const createRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const makeProduct = (index, random) => {
    const createdAt = new Date(Date.UTC(2020, 0, 1) + index * 1_000);
    return {
        name: `MAREN Benchmark Product ${String(index + 1).padStart(6, "0")}`,
        description: descriptions[Math.floor(random() * descriptions.length)],
        price: 100 + Math.floor(random() * 100_000),
        images: [],
        category: categories[Math.floor(random() * categories.length)],
        stock: index === 0 ? 1 : 5 + Math.floor(random() * 96),
        brand: brands[Math.floor(random() * brands.length)],
        isActive: true,
        createdAt,
        updatedAt: createdAt
    };
};

const main = async () => {
    const db = await connectBenchmarkDatabase();
    const startedAt = new Date().toISOString();
    try {
        const collections = await db.listCollections({ name: "products" }, { nameOnly: true }).toArray();
        if (collections.length === 0) {
            await db.createCollection("products");
        }
        const products = db.collection("products");
        const indexesBefore = await products.indexes();
        await products.deleteMany({});
        const random = createRandom(SEED);

        for (let offset = 0; offset < PRODUCT_COUNT; offset += BATCH_SIZE) {
            const batchSize = Math.min(BATCH_SIZE, PRODUCT_COUNT - offset);
            const batch = Array.from({ length: batchSize }, (_, batchIndex) =>
                makeProduct(offset + batchIndex, random)
            );
            await products.insertMany(batch, { ordered: true });
            console.log(`Seeded ${offset + batchSize}/${PRODUCT_COUNT} products`);
        }

        const actualCount = await products.countDocuments();
        if (actualCount !== PRODUCT_COUNT) {
            throw new Error(`Expected ${PRODUCT_COUNT} products after seeding; found ${actualCount}.`);
        }

        const record = {
            runId,
            status: "passed",
            startedAt,
            finishedAt: new Date().toISOString(),
            databaseName: db.databaseName,
            productCount: actualCount,
            seed: `0x${SEED.toString(16)}`,
            generator: "mulberry32",
            fixedCreatedAtRange: {
                first: new Date(Date.UTC(2020, 0, 1)).toISOString(),
                last: new Date(Date.UTC(2020, 0, 1) + (PRODUCT_COUNT - 1) * 1_000).toISOString()
            },
            indexesBefore,
            gitCommit,
            machine: machineInfo,
            command: "npm --prefix backend run benchmark:all"
        };
        await saveRawResult(`seed-${runId}.json`, record);
        console.log(`Seed verification: ${actualCount} products; seed ${record.seed}.`);
    } finally {
        await mongoose.disconnect();
    }
};

main().catch(async (error) => {
    console.error(`Benchmark catalog seed failed: ${error.stack || error.message}`);
    const record = {
        runId,
        status: "failed",
        error: error.message,
        gitCommit,
        machine: machineInfo,
        command: "npm --prefix backend run benchmark:all"
    };
    try {
        await saveRawResult(`seed-${runId}.json`, record);
    } catch (writeError) {
        console.error(`Could not save seed failure output: ${writeError.message}`);
    }
    process.exitCode = 1;
});
