import httpStatus from "http-status";
import { Cart } from "../model/cart.model.js";
import { Product } from "../model/product.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

export const manageCart = catchAsync(async (req, res) => {
  const { productId, quantity, action = "add" } = req.body;
  const userId = req.user._id;

  if (action !== "get" && action !== "clear" && (!productId || quantity < 0)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Valid productId and quantity required"
    );
  }

  let cart = await Cart.findOne({ user: userId });

  if (action === "get") {
    if (cart) await cart.populate("items.product");
    const data = cart ? cart.items : [];
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Cart fetched successfully",
      data,
    });
  }

  if (action === "clear") {
    if (cart) {
      cart.items = [];
      await cart.save();
    }
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Cart cleared",
      data: { cart: [] },
    });
  }

  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
  }

  if (action === "remove") {
    cart.items = cart.items.filter(
      (item) => item.product.toString() !== productId
    );
    await cart.save();
    await cart.populate("items.product");

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Product removed from cart",
      data: { cart: cart.items },
    });
  }

  if (action === "update") {
    const itemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId
    );
    if (itemIndex === -1) {
      throw new AppError(httpStatus.NOT_FOUND, "Item not in cart");
    }

    if (quantity === 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      const product = await Product.findById(productId);
      if (!product || product.remainingAmount < quantity) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Product not available or insufficient stock"
        );
      }
      cart.items[itemIndex].quantity = quantity;
    }

    await cart.save();
    await cart.populate("items.product");

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Cart item updated",
      data: { cart: cart.items },
    });
  }

  if (action === "add") {
    const product = await Product.findById(productId);
    if (!product || product.remainingUnit < quantity) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Product not available or insufficient stock"
      );
    }

    const existingItem = cart.items.find(
      (item) => item.product.toString() === productId
    );
    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      cart.items.push({ product: productId, quantity });
    }

    await cart.save();
    await cart.populate("items.product");

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Product added to cart",
      data: { cart: cart.items },
    });
  }

  throw new AppError(httpStatus.BAD_REQUEST, "Invalid action");
});

export const clearCart = catchAsync(async (req, res) => {
  const userId = req.user._id;
  await Cart.findOneAndUpdate(
    { user: userId },
    { items: [] },
    { upsert: true, new: true }
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Cart cleared",
    data: { cart: [] },
  });
});
