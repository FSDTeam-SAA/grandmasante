import httpStatus from "http-status";
import { Order } from "../model/order.model.js";
import { Product } from "../model/product.model.js";
import { User } from "../model/user.model.js";
import { Cart } from "../model/cart.model.js";
import { PaymentInfo } from "../model/payment.model.js";
import stripe from "stripe";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

export const createPaymentForProduct = catchAsync(async (req, res) => {
  const { useCart = true } = req.query;
  const userId = req.user._id;
  const user = await User.findById(userId);
  let products = [];
  let total = 0;

  if (useCart === "true") {
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
        "Invalid productId or quantity in items"
      );
    }
    const product = await Product.findById(item.productId);
    if (!product) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        `Product ${item.productId} not found`
      );
    }
    if (product.remainingUnit < item.quantity) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for ${product.name}`
      );
    }
    total += product.perPrice * item.quantity;
  }

  // Create or reuse Stripe customer
  let customer;
  const existingCustomers = await stripeInstance.customers.list({
    email: user.email,
  });
  customer = existingCustomers.data[0];
  if (!customer) {
    customer = await stripeInstance.customers.create({
      email: user.email,
      metadata: { userId: userId.toString() },
    });
  }

  const paymentIntent = await stripeInstance.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: "usd",
    customer: customer.id,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: {
      userId: userId.toString(),
      type: "product",
      products: JSON.stringify(products),
      total,
    },
  });

  // Create order
  const order = new Order({
    user: userId,
    products: products.map((p) => ({
      product: p.productId,
      quantity: p.quantity,
    })),
    status: "ongoing",
    total,
    payment: { transactionId: paymentIntent.id, status: "pending" },
  });
  await order.save();

  // Save payment record
  const paymentRecord = new PaymentInfo({
    userId,
    planId: null,
    price: total,
    finalPrice: total,
    transactionId: paymentIntent.id,
    paymentStatus: "pending",
    type: "product",
  });
  await paymentRecord.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Checkout created, proceed to payment",
    data: {
      orderId: order._id,
      transactionId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      total,
      customerId: customer.id,
      products,
    },
  });
});

export const confirmCheckoutPayment = catchAsync(async (req, res) => {
  const { paymentIntentId, paymentMethodId } = req.body;
  const userId = req.user._id;
  if (!paymentIntentId || !paymentMethodId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Both paymentIntentId and paymentMethodId are required"
    );
  }

  try {
    // Fetch PaymentIntent status from Stripe
    const paymentIntent = await stripeInstance.paymentIntents.retrieve(
      paymentIntentId
    );

    // Handle already succeeded PaymentIntent gracefully
    if (paymentIntent.status === "succeeded") {
      const order = await Order.findOne({
        "payment.transactionId": paymentIntentId,
      });
      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "Payment has already been completed",
        data: {
          orderId: order?._id,
          transactionId: paymentIntent.id,
        },
      });
    }

    // Confirm payment
    const confirmedPayment = await stripeInstance.paymentIntents.confirm(
      paymentIntentId,
      {
        payment_method: paymentMethodId,
      }
    );

    const order = await Order.findOne({
      "payment.transactionId": paymentIntentId,
    }).populate([
      { path: "user", select: "name email phone" },
      { path: "products.product", select: "name perPrice" },
    ]);
    const paymentRecord = await PaymentInfo.findOne({
      transactionId: paymentIntentId,
      userId,
      type: "product",
    });

    if (!order || !paymentRecord) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        "Order or payment record not found"
      );
    }

    if (confirmedPayment.status === "succeeded") {
      paymentRecord.paymentStatus = "complete";
      paymentRecord.paymentMethod = confirmedPayment.payment_method_types[0];
      await paymentRecord.save();

      order.payment.status = "paid";
      order.transactionId = paymentIntentId;
      await order.save();

      // Deduct stock
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
          transactionId: paymentIntentId,
        },
      });
    } else {
      paymentRecord.paymentStatus = "failed";
      await paymentRecord.save();
      throw new AppError(httpStatus.BAD_REQUEST, "Payment failed");
    }
  } catch (error) {
    console.error("Stripe confirm error:", error);
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
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
    { new: true }
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
