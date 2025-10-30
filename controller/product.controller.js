import httpStatus from "http-status";
import { Product } from "../model/product.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { authorizeRole } from "./auth.controller.js";

export const getProducts = catchAsync(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const products = await Product.paginate(
    {},
    {
      page: parseInt(page),
      limit: parseInt(limit),
      populate: "image",
      sort: { addedDate: -1 },
    }
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Products fetched successfully",
    data: products,
  });
});

export const addProduct = catchAsync(async (req, res) => {
  const { name, totalUnit, unit = "pieces", perPrice } = req.body;
  if (!name || !totalUnit || !perPrice) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Name, total amount, and price required"
    );
  }
  let image = {};
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    image = { public_id: result.public_id, url: result.secure_url };
  }
  const product = await Product.create({
    name,
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
    data: product,
  });
});

export const updateProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!product) throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    product.image = { public_id: result.public_id, url: result.secure_url };
    await product.save();
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Product updated successfully",
    data: product,
  });
});

export const deleteProduct = catchAsync(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Product deleted successfully",
    data: product,
  });
});
