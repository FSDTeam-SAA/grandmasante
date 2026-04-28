import httpStatus from "http-status";
import { Product, PRODUCT_CATEGORIES } from "../model/product.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import cloudinary from "cloudinary";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import {
  CURRENCY_DISPLAY,
  NOTCHPAY_CURRENCY,
} from "../utils/pricing.js";

const serializeProduct = (product) => {
  const plainProduct = product?.toObject ? product.toObject() : product;
  if (!plainProduct) return plainProduct;

  return {
    ...plainProduct,
    category: plainProduct.category ?? null,
    currency: NOTCHPAY_CURRENCY,
    currencyDisplay: CURRENCY_DISPLAY,
  };
};

const normalizeCategory = (category) => {
  if (typeof category !== "string") return undefined;
  const normalized = category.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!PRODUCT_CATEGORIES.includes(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid product category");
  }
  return normalized;
};

export const getProducts = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, search = "", category } = req.query;
  const query = {};
  const normalizedCategory = normalizeCategory(category);

  if (normalizedCategory) {
    query.category = normalizedCategory;
  }

  if (typeof search === "string" && search.trim()) {
    query.$or = [
      { name: { $regex: search.trim(), $options: "i" } },
      { description: { $regex: search.trim(), $options: "i" } },
    ];
  }

  const products = await Product.paginate(
    query,
    {
      page: parseInt(page),
      limit: parseInt(limit),
      populate: "image",
      sort: { addedDate: -1 },
    }
  );
  products.docs = products.docs.map((product) => serializeProduct(product));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Products fetched successfully",
    data: products,
  });
});

export const addProduct = catchAsync(async (req, res) => {
  const {
    name,
    description = "",
    category,
    totalUnit,
    unit = "pieces",
    perPrice,
  } =
    req.body;
  if (!name || !totalUnit || totalUnit <= 0 || !perPrice || perPrice <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Name, positive totalUnit, and positive perPrice required"
    );
  }
  let image = {};
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    image = { public_id: result.public_id, url: result.secure_url };
  }
  const product = await Product.create({
    name,
    description,
    category: normalizeCategory(category),
    image,
    totalUnit,
    remainingUnit: totalUnit,
    unit,
    perPrice,
  });
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Product added successfully",
    data: serializeProduct(product),
  });
});

export const updateProduct = catchAsync(async (req, res) => {
  const { name, description, category, totalUnit, unit, perPrice } = req.body;
  if (totalUnit && totalUnit <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "totalUnit must be positive");
  }
  if (perPrice && perPrice <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "perPrice must be positive");
  }

  const updatePayload = {
    name,
    description,
    totalUnit,
    unit,
    perPrice,
  };

  if (Object.prototype.hasOwnProperty.call(req.body, "category")) {
    updatePayload.category = normalizeCategory(category);
  }

  const product = await Product.findByIdAndUpdate(
    req.params.id,
    updatePayload,
    { new: true }
  );
  if (!product) throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  if (req.file) {
    // Delete old image if exists
    if (product.image && product.image.public_id) {
      await cloudinary.uploader.destroy(product.image.public_id);
    }
    const result = await uploadOnCloudinary(req.file.buffer);
    product.image = { public_id: result.public_id, url: result.secure_url };
    await product.save();
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Product updated successfully",
    data: serializeProduct(product),
  });
});

export const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  if (product.image && product.image.public_id) {
    await cloudinary.uploader.destroy(product.image.public_id);
  }
  await Product.findByIdAndDelete(req.params.id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Product deleted successfully",
    data: serializeProduct(product),
  });
});
