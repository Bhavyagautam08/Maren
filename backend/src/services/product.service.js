import Product from "../models/product.model.js";
import { DISABLE_PRODUCT_CACHE, PRODUCT_CACHE_NAMESPACE } from "../config/env.js";
import { getCache, setCache , invalidateProductCache} from "./cache.service.js";

export const createProduct = async (data) => {
    const { name, description, price, images, stock, brand, category } = data;

    const product = await Product.create({
        name,
        description,
        price,
        images,
        stock,
        brand,
        category
    });

    if (product) {
        await invalidateProductCache();
    }

    return product;
};

export const getAllProducts = async (
    page = 1,
    limit = 10,
    search = "",
    sort = "newest",
    category = ""
) => {
    const namespace = PRODUCT_CACHE_NAMESPACE
        ? `${PRODUCT_CACHE_NAMESPACE}:`
        : "";
    const cacheKey = `products:${namespace}page=${page}:limit=${limit}:search=${search}:sort=${sort}:category=${category}`;
    const cachedProducts = DISABLE_PRODUCT_CACHE
        ? null
        : await getCache(cacheKey);

    if (cachedProducts) {
        return cachedProducts;
    }
    const skip = (page - 1) * limit;
    const filter = {};

    if (category) {
        filter.category = {
            $regex: category,
            $options: "i"
        };
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
            { brand: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } }
        ];
    }

    let sortOption = {};

    if (sort === "price_asc") {
        sortOption = { price: 1 };
    } else if (sort === "price_desc") {
        sortOption = { price: -1 };
    } else if (sort === "newest") {
        sortOption = { createdAt: -1 };
    } else if (sort === "oldest") {
        sortOption = { createdAt: 1 };
    }

    const products = await Product.find(filter)
        .sort(sortOption)
        .skip(skip)
        .limit(limit);

    const totalProducts = await Product.countDocuments(filter);

    const totalPages = Math.ceil(totalProducts / limit);

    const result = {
        products,
        pagination: {
        currentPage: page,
        limit,
        totalProducts,
        totalPages
        }
    };

    if (!DISABLE_PRODUCT_CACHE) {
        await setCache(cacheKey, result);
    }

    return result;
};

export const getProductById = async (id) => {

    const key = `product:${id}`;

    const cache = await getCache(key);

    if (cache) {
        return cache;
    }

    const product = await Product.findById(id);

    if (product) {
        await setCache(key, product);
    }

    return product;
};

export const updateProductById = async (id, data) => {

    const product = await Product.findByIdAndUpdate(
        id,
        data,
        {
            new: true,
            runValidators: true
        }
    );

    if (product) {
        await deleteCache(`product:${id}`);
        await invalidateProductCache();
    }

    return product;
};

export const deleteProductById = async (id) => {

    const product = await Product.findByIdAndDelete(id);

    if (product) {
        await deleteCache(`product:${id}`);
        await invalidateProductCache();
    }

    return product;
};