import httpStatus from "http-status";
import { SubscriptionPlan } from "../model/subcriptionPlan.model.js";
import { UserSubscription } from "../model/userSubcription.model.js";
import { User } from "../model/user.model.js";
import { Notification } from "../model/notification.model.js";
import { io } from "../server.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import stripe from "stripe";
import { PaymentInfo } from "../model/payment.model.js";

const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

// Get all active plans
export const getSubscriptionPlans = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).select(
    "name description price savePercentage userLimit carryCredit"
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans,
  });
});

// Create Stripe Payment Intent for subscription
export const createSubscriptionPayment = catchAsync(async (req, res) => {
  const { planId } = req.body;
  if (!planId)
    throw new AppError(httpStatus.BAD_REQUEST, "Plan ID is required");

  const userId = req.user._id;
  const user = await User.findById(userId);
  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) throw new AppError(httpStatus.NOT_FOUND, "Plan not found");

  // Check for active subscription
  const activeSub = await UserSubscription.findOne({
    user: userId,
    status: "active",
  });
  if (activeSub) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You already have an active subscription"
    );
  }

  // Stripe customer
  let customer;
  try {
    customer = await stripeInstance.customers.create({
      email: user.email,
      metadata: { userId: userId.toString() },
    });
  } catch (error) {
    const customers = await stripeInstance.customers.list({
      email: user.email,
    });
    customer = customers.data[0];
    if (!customer)
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        "Stripe customer error"
      );
  }

  // Payment Intent
  const paymentIntent = await stripeInstance.paymentIntents.create({
    amount: Math.round(plan.price * 100),
    currency: "usd",
    customer: customer.id,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { userId: userId.toString(), planId: plan._id.toString() },
  });

  // Save payment record
  const subscriptionPayment = await PaymentInfo.create({
    userId,
    planId,
    price: plan.price,
    finalPrice: plan.price,
    transactionId: paymentIntent.id,
    paymentStatus: "pending",
    type: "subscription",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Subscription payment intent created",
    data: {
      transactionId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      finalPrice: plan.price,
      customerId: customer.id,
    },
  });
});

// Confirm Stripe Payment & activate subscription
export const confirmSubscriptionPayment = catchAsync(async (req, res) => {
  const { paymentIntentId, paymentMethodId } = req.body;
  const userId = req.user._id;
  if (!paymentIntentId || !paymentMethodId)
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "PaymentIntentId and PaymentMethodId required"
    );

  try {
    const paymentIntent = await stripeInstance.paymentIntents.confirm(
      paymentIntentId,
      {
        payment_method: paymentMethodId,
      }
    );

    const subscriptionPayment = await PaymentInfo.findOne({
      transactionId: paymentIntentId,
      userId,
      type: "subscription",
    }).populate("planId");

    if (!subscriptionPayment)
      throw new AppError(httpStatus.NOT_FOUND, "Payment record not found");

    if (paymentIntent.status !== "succeeded") {
      subscriptionPayment.paymentStatus = "failed";
      await subscriptionPayment.save();
      throw new AppError(httpStatus.BAD_REQUEST, "Payment failed");
    }

    subscriptionPayment.paymentStatus = "complete";
    subscriptionPayment.paymentMethod = paymentIntent.payment_method_types[0];
    await subscriptionPayment.save();

    // Activate subscription
    const userSub = await UserSubscription.create({
      user: userId,
      plan: subscriptionPayment.planId._id,
      creditsRemaining: subscriptionPayment.planId.carryCredit,
      status: "active",
      paymentMethod: "stripe",
      stripeTransactionId: paymentIntentId,
    });

    // Update user plan
    await User.findByIdAndUpdate(userId, {
      currentPlan: subscriptionPayment.planId.name,
      subscription: userSub._id,
      credit: subscriptionPayment.planId.carryCredit,
    });

    // Notification
    const newNotif = await Notification.create({
      user: userId,
      title: "Subscription Purchased",
      message: `Your ${subscriptionPayment.planId.name} subscription is active with ${subscriptionPayment.planId.carryCredit} credits.`,
      type: "subscription",
    });

    io.emit("notification", newNotif);

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Subscription activated successfully",
      data: {
        transactionId: paymentIntentId,
        planId: subscriptionPayment.planId._id,
        userSubId: userSub._id,
        creditsRemaining: userSub.creditsRemaining,
      },
    });
  } catch (error) {
    console.error(error);
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
});

// Get all plans (admin)
export const getSubscriptionPlansAdmin = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans,
  });
});

// Add plan
export const addSubscriptionPlan = catchAsync(async (req, res) => {
  const { name, description, price, savePercentage, userLimit, carryCredit } =
    req.body;
  if (!name || !description || !price || !carryCredit)
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Name, description, price and carryCredit required"
    );

  const plan = await SubscriptionPlan.create({
    name,
    description,
    price,
    savePercentage: savePercentage || "0%",
    userLimit: userLimit || "1 user",
    carryCredit,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Plan added successfully",
    data: plan,
  });
});

// Update plan
export const updateSubscriptionPlan = catchAsync(async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true }
  );
  if (!plan) throw new AppError(httpStatus.NOT_FOUND, "Plan not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plan updated successfully",
    data: plan,
  });
});

// Toggle / Delete plan
export const toggleSubscriptionPlan = catchAsync(async (req, res) => {
  const { action } = req.body;
  if (!["active", "inactive", "delete"].includes(action))
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid action");

  let plan;
  if (action === "delete")
    plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
  else
    plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { isActive: action === "active" },
      { new: true }
    );

  if (!plan) throw new AppError(httpStatus.NOT_FOUND, "Plan not found");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Plan ${action}d successfully`,
    data: plan,
  });
});
