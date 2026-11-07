import dotenv from "dotenv" ;

dotenv.config() ;

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI ;
const JWT_SECRET = process.env.JWT_SECRET ;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_ENABLED = process.env.REDIS_ENABLED !== "false";
const DISABLE_PRODUCT_CACHE = process.env.DISABLE_PRODUCT_CACHE === "true";
const PRODUCT_CACHE_NAMESPACE = process.env.PRODUCT_CACHE_NAMESPACE || "";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const CLIENT_URLS = [...new Set([
    CLIENT_URL,
    ...(process.env.CLIENT_URLS || "").split(",").map((url) => url.trim()).filter(Boolean),
    "http://localhost:3000",
    "http://localhost:3001",
].map((url) => new URL(url).origin))];

export {
    PORT,
    MONGO_URI,
    JWT_SECRET,
    REFRESH_TOKEN_SECRET,
    REDIS_URL,
    UPSTASH_REDIS_REST_TOKEN,
    REDIS_ENABLED,
    DISABLE_PRODUCT_CACHE,
    PRODUCT_CACHE_NAMESPACE,
    CLIENT_URLS
};