import httpStatus from "http-status";
import { Order } from "../model/order.model.js";
import { Product } from "../model/product.model.js";
import { User } from "../model/user.model.js";
import { Cart } from "../model/cart.model.js";
import { PaymentInfo } from "../model/payment.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import {
  amountToMinorUnit,
  createNotchPayPaymentLink,
  getNotchPayStatus,
  getNotchPayTransaction,
  isNotchPayFailureStatus,
  retrieveNotchPayPaymentByReferences,
} from "../utils/notchpay.service.js";

const NOTCHPAY_CURRENCY = (
  process.env.NOTCHPAY_CURRENCY || "XAF"
).toUpperCase();

const buildReference = (prefix, userId) => `${prefix}_${userId}_${Date.now()}`;

const getPaymentCustomer = (user) => ({
  name: user?.name || user?.username || "Customer",
  email: user?.email,
  phone: user?.phone,
});

const getCheckoutCallbackUrl = () =>
  process.env.NOTCHPAY_PRODUCT_CALLBACK_URL ||
  process.env.NOTCHPAY_CALLBACK_URL ||
  process.env.CLIENT_URL;

export const createPaymentForProduct = catchAsync(async (req, res) => {
  const useCart = req.query.useCart !== "false";
  const userId = req.user._id;
  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  let products = [];
  let total = 0;

  if (useCart) {
    const cart = await Cart.findOne({ user: userId }).populate("items.product");
    if (!cart || cart.items.length === 0) {
      throw new AppError(httpStatus.BAD_REQUEST, "Cart is empty");
    }
    products = cart.items.map((item) => ({
      productId: item.product._id,
      quantity: item.quantity,
      price: item.product.perPrice,
    }));
  } else {
    const { products: directProducts } = req.body;
    if (
      !directProducts ||
      !Array.isArray(directProducts) ||
      directProducts.length === 0
    ) {
      throw new AppError(httpStatus.BAD_REQUEST, "Products required as array");
    }
    products = directProducts;
  }

  // Validate stock and calculate total
  for (let item of products) {
    if (!item.productId || !item.quantity || item.quantity < 1) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Invalid productId or quantity in items",
      );
    }
    const product = await Product.findById(item.productId);
    if (!product) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        `Product ${item.productId} not found`,
      );
    }
    if (product.remainingUnit < item.quantity) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for ${product.name}`,
      );
    }
    total += product.perPrice * item.quantity;
  }

  const transactionReference = buildReference("ord", userId.toString());
  const amountInMinorUnit = amountToMinorUnit(total, NOTCHPAY_CURRENCY);

  let notchPayPayment;
  try {
    notchPayPayment = await createNotchPayPaymentLink({
      amount: amountInMinorUnit,
      currency: NOTCHPAY_CURRENCY,
      reference: transactionReference,
      callback: getCheckoutCallbackUrl(),
      description: `Checkout payment for order by ${user.email}`,
      customer: getPaymentCustomer(user),
      metadata: {
        type: "product",
        userId: userId.toString(),
      },
    });
  } catch (error) {
    throw new AppError(
      error?.statusCode || httpStatus.BAD_GATEWAY,
      error?.message || "Failed to create NotchPay payment link",
    );
  }

  // Create order
  const order = new Order({
    user: userId,
    products: products.map((p) => ({
      product: p.productId,
      quantity: p.quantity,
    })),
    status: "ongoing",
    total,
    payment: { transactionId: transactionReference, status: "pending" },
  });
  await order.save();

  const transaction = getNotchPayTransaction(notchPayPayment.response);

  // Save payment record
  const paymentRecord = new PaymentInfo({
    userId,
    planId: null,
    price: total,
    finalPrice: total,
    transactionId: transactionReference,
    providerTransactionId: transaction?.id || null,
    gatewayReference: transaction?.reference || transaction?.id || null,
    paymentStatus: "pending",
    paymentMethod: "notchpay",
    type: "product",
  });
  await paymentRecord.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Checkout payment link created",
    data: {
      orderId: order._id,
      transactionId: transactionReference,
      reference: transactionReference,
      paymentLink: notchPayPayment.authorizationUrl,
      currency: NOTCHPAY_CURRENCY,
      amountInMinorUnit,
      providerTransactionId: transaction?.id || transaction?.reference || null,
      status: getNotchPayStatus(notchPayPayment.response),
      total,
      products,
    },
  });
});

export const confirmCheckoutPayment = catchAsync(async (req, res) => {
  const {
    transactionId,
    reference,
    paymentIntentId, // Backward compatibility
    trxref,
    notchpay_trxref,
  } = req.body;
  const userId = req.user._id;
  const localReferenceCandidates = [
    transactionId,
    paymentIntentId,
    trxref,
    notchpay_trxref,
    reference,
  ].filter(Boolean);

  if (!localReferenceCandidates.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Transaction reference is required",
    );
  }

  let paymentRecord = await PaymentInfo.findOne({
    userId,
    type: "product",
    transactionId: { $in: localReferenceCandidates },
  });

  if (!paymentRecord && reference) {
    paymentRecord = await PaymentInfo.findOne({
      userId,
      type: "product",
      gatewayReference: reference,
    });
  }

  if (!paymentRecord) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment record not found");
  }

  const localTransactionReference = paymentRecord.transactionId;

  const order = await Order.findOne({
    "payment.transactionId": localTransactionReference,
  }).populate([
    { path: "user", select: "name email phone" },
    { path: "products.product", select: "name perPrice" },
  ]);

  if (!order || !paymentRecord) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Order or payment record not found",
    );
  }

  if (
    order.payment?.status === "paid" ||
    paymentRecord.paymentStatus === "complete"
  ) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Payment has already been completed",
      data: {
        orderId: order._id,
        transactionId: localTransactionReference,
      },
    });
  }

  let notchPayResult;
  try {
    notchPayResult = await retrieveNotchPayPaymentByReferences([
      reference,
      paymentRecord.gatewayReference,
      paymentRecord.providerTransactionId,
      transactionId,
      paymentIntentId,
      trxref,
      notchpay_trxref,
      localTransactionReference,
    ]);
  } catch (error) {
    throw new AppError(
      error?.statusCode || httpStatus.BAD_GATEWAY,
      error?.message || "Failed to verify payment with NotchPay",
    );
  }
  const notchPayResponse = notchPayResult.response;
  const paymentStatus = String(
    getNotchPayStatus(notchPayResponse) || "",
  ).toLowerCase();
  const transaction = getNotchPayTransaction(notchPayResponse);

  if (paymentStatus === "complete") {
    paymentRecord.paymentStatus = "complete";
    paymentRecord.paymentMethod =
      transaction?.payment_method || transaction?.channel || "notchpay";
    paymentRecord.providerTransactionId =
      transaction?.id || paymentRecord.providerTransactionId || null;
    paymentRecord.gatewayReference =
      transaction?.reference ||
      notchPayResult.matchedReference ||
      paymentRecord.gatewayReference ||
      null;
    await paymentRecord.save();

    order.payment.status = "paid";
    order.payment.transactionId = localTransactionReference;
    await order.save();

    // Deduct stock once after successful payment confirmation
    for (let item of order.products) {
      await Product.findByIdAndUpdate(item.product._id, {
        $inc: { remainingUnit: -item.quantity },
      });
    }

    // Add to user purchases
    await User.findByIdAndUpdate(userId, {
      $addToSet: {
        purchases: { $each: order.products.map((p) => p.product._id) },
      },
    });

    // Clear cart
    await Cart.findOneAndUpdate({ user: userId }, { items: [] });

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Checkout payment successful",
      data: {
        orderId: order._id,
        transactionId: localTransactionReference,
      },
    });
  }

  if (isNotchPayFailureStatus(paymentStatus)) {
    paymentRecord.paymentStatus = "failed";
    await paymentRecord.save();
    throw new AppError(httpStatus.BAD_REQUEST, "Payment failed");
  }

  sendResponse(res, {
    statusCode: httpStatus.ACCEPTED,
    success: true,
    message: "Payment is not completed yet",
    data: {
      orderId: order._id,
      transactionId: localTransactionReference,
      status: paymentStatus || "pending",
    },
  });
});

export const getOrders = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query;
  const userId = req.user._id;

  const filter = { user: userId };
  if (status) filter.status = status;

  const orders = await Order.paginate(filter, {
    page: parseInt(page),
    limit: parseInt(limit),
    sort: { createdAt: -1 },
    populate: [
      { path: "user", select: "name email phone" },
      { path: "products.product", select: "name perPrice" },
    ],
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Orders fetched successfully",
    data: orders,
  });
});

export const updateOrderStatus = catchAsync(async (req, res) => {
  const { status } = req.body;
  if (!["ongoing", "completed", "delivered"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid status");
  }
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true },
  ).populate([
    { path: "user", select: "name email phone" },
    { path: "products.product", select: "name perPrice" },
  ]);
  if (!order) throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Order status updated",
    data: order,
  });
});

export const deleteOrder = catchAsync(async (req, res) => {
  const order = await Order.findByIdAndDelete(req.params.id);
  if (!order) throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Order deleted successfully",
    data: order,
  });
});

export const getSingleOrder = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const order = await Order.findById(req.params.id).populate([
    { path: "user", select: "name email phone" },
    { path: "products.product", select: "name perPrice" },
  ]);

  if (!order) {
    throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  }

  // User should only access their own order
  if (order.user._id.toString() !== userId.toString()) {
    throw new AppError(httpStatus.FORBIDDEN, "Unauthorized access");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Order fetched successfully",
    data: order,
  });
});

export const getOrdersByStatus = catchAsync(async (req, res) => {
  const { status } = req.params;
  if (!["ongoing", "completed", "delivered"].includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid status");
  }
  const orders = await Order.find({ status }).populate([
    { path: "user", select: "name email phone" },
    { path: "products.product", select: "name perPrice" },
  ]);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Orders fetched successfully",
    data: orders,
  });
});
