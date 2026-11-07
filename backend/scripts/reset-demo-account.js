import mongoose from "mongoose";
import { MONGO_URI, REDIS_ENABLED } from "../src/config/env.js";
import redisClient, { scanKeys } from "../src/config/redis.js";
import Cart from "../src/models/cart.model.js";
import Order from "../src/models/order.model.js";
import Product from "../src/models/product.model.js";
import User from "../src/models/user.model.js";
import { deleteCache, invalidateProductCache } from "../src/services/cache.service.js";

const email = process.env.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase();

const resetDemoAccount = async () => {
    if (!MONGO_URI) {
        throw new Error("MONGO_URI must be configured in backend/.env.");
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.example$/.test(email)) {
        throw new Error("DEMO_ACCOUNT_EMAIL must be a valid address in the reserved .example domain.");
    }

    await mongoose.connect(MONGO_URI);
    const user = await User.findOne({ email });
    if (!user) {
        throw new Error(`Demo account ${email} was not found. Run "npm run seed:demo" first.`);
    }

    const session = await mongoose.startSession();
    let orderCount = 0;
    let cartCount = 0;
    const restoredProductIds = new Set();

    try {
        await session.withTransaction(async () => {
            const orders = await Order.find({ user: user._id }).session(session);
            const stockToRestore = new Map();
            orderCount = orders.length;

            for (const order of orders) {
                if (order.status === "cancelled") {
                    continue;
                }
                for (const item of order.items) {
                    const productId = item.product.toString();
                    stockToRestore.set(
                        productId,
                        (stockToRestore.get(productId) || 0) + item.quantity
                    );
                }
            }

            for (const [productId, quantity] of stockToRestore) {
                const result = await Product.updateOne(
                    { _id: productId },
                    { $inc: { stock: quantity } },
                    { session }
                );
                if (result.matchedCount !== 1) {
                    throw new Error(`Cannot restore stock: product ${productId} no longer exists.`);
                }
                restoredProductIds.add(productId);
            }

            await Order.deleteMany({ user: user._id }, { session });
            const cartResult = await Cart.deleteOne({ user: user._id }, { session });
            cartCount = cartResult.deletedCount;
        });
    } finally {
        await session.endSession();
    }

    for (const productId of restoredProductIds) {
        await deleteCache(`product:${productId}`);
    }
    await invalidateProductCache();

    if (REDIS_ENABLED) {
        const keys = await scanKeys(`idempotency:order:${user._id}:*`);
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
    }

    console.log(
        `Reset ${user.email}: removed ${orderCount} order(s), ${cartCount} cart(s), restored stock for ${restoredProductIds.size} product(s).`
    );
};

resetDemoAccount()
    .catch((error) => {
        console.error("Could not reset the demo account:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
