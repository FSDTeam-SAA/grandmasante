import httpStatus from "http-status";
import { SubscriptionPlan } from "../model/subcriptionPlan.model.js";
import { UserSubscription } from "../model/userSubcription.model.js";
import { User } from "../model/user.model.js";
import { Coupon } from "../model/coupon.model.js";
import { Notification } from "../model/notification.model.js";
import { io } from "../server.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import stripe from "stripe";
import { PaymentInfo } from "../model/payment.model.js";

const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

export const getSubscriptionPlans = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).select(
    "name priceMonthly priceYearly benefits hasAds maxItems maxCurrencies"
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans,
  });
});

export const createSubscriptionPayment = catchAsync(async (req, res) => {
  const { planId, isYearly, couponCode, email, phone, country } = req.body;
  const userId = req.user._id;

  if (!planId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Plan ID is required");
  }

  // Validate billing details
  if (!email || !phone || !country) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Billing details (email, phone, country) are required"
    );
  }

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) {
    throw new AppError(httpStatus.NOT_FOUND, "Plan not found");
  }

  let discount = 0;
  let finalPrice = isYearly ? plan.priceYearly : plan.priceMonthly;
  let couponUsed = null;
  if (couponCode) {
    const coupon = await Coupon.findOne({
      code: couponCode,
      status: "active",
      applicablePlans: { $in: [plan.name] },
    });

    if (
      !coupon ||
      new Date() > coupon.expiryDate ||
      (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit)
    ) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid coupon");
    }
    if (coupon.discountType === "percent") {
      discount = (finalPrice * coupon.discountValue) / 100;
    } else {
      discount = coupon.discountValue;
    }
    finalPrice -= discount;
    couponUsed = couponCode;
    await Coupon.findByIdAndUpdate(coupon._id, { $inc: { usedCount: 1 } });
  }

  // Create or retrieve Stripe customer with billing details
  let customer;
  try {
    customer = await stripeInstance.customers.create({
      email,
      phone,
      address: {
        country,
      },
      metadata: {
        userId: userId.toString(),
      },
    });
  } catch (error) {
    customer = await stripeInstance.customers.list({ email }).data[0];
    if (!customer) {
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        "Failed to create/retrieve customer"
      );
    }
  }

  const paymentIntent = await stripeInstance.paymentIntents.create({
    amount: Math.round(finalPrice * 100),
    currency: "usd",
    customer: customer.id,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: {
      userId: userId.toString(),
      planId: planId.toString(),
      isYearly: isYearly.toString(),
      couponUsed: couponUsed || "",
    },
  });

  // Save payment record as pending
  const subscriptionPayment = new PaymentInfo({
    userId,
    planId,
    price: isYearly ? plan.priceYearly : plan.priceMonthly,
    discount,
    finalPrice,
    transactionId: paymentIntent.id,
    paymentStatus: "pending",
    couponUsed,
    isYearly,
    type: "subscription",
  });
  await subscriptionPayment.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Subscription payment intent created",
    data: {
      transactionId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      finalPrice,
      discount,
      customerId: customer.id,
    },
  });
});

export const confirmSubscriptionPayment = catchAsync(async (req, res) => {
  const { paymentIntentId, paymentMethodId } = req.body;
  const userId = req.user._id;

  if (!paymentIntentId || !paymentMethodId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Both paymentIntentId and paymentMethodId are required."
    );
  }

  try {
    const paymentIntent = await stripeInstance.paymentIntents.confirm(
      paymentIntentId,
      { payment_method: paymentMethodId }
    );

    const subscriptionPayment = await PaymentInfo.findOne({
      transactionId: paymentIntentId,
      userId,
    }).populate("planId");

    if (!subscriptionPayment) {
      throw new AppError(httpStatus.NOT_FOUND, "Payment record not found.");
    }

    if (paymentIntent.status === "succeeded") {
      subscriptionPayment.paymentStatus = "complete";
      subscriptionPayment.paymentMethod = paymentIntent.payment_method_types[0];
      await subscriptionPayment.save();

      // Create UserSubscription on success
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setFullYear(
        endDate.getFullYear() + (subscriptionPayment.isYearly ? 1 : 0.083)
      );

      const userSub = await UserSubscription.create({
        user: userId,
        plan: subscriptionPayment.planId._id,
        startDate,
        endDate,
        status: "active",
        paymentMethod: "stripe",
        stripeSubscriptionId: paymentIntentId,
        couponUsed: subscriptionPayment.couponUsed || null,
      });

      await User.findByIdAndUpdate(userId, {
        currentPlan: subscriptionPayment.planId.name,
        subscription: userSub._id,
      });

      // Notification for subscription purchase
      const user = await User.findById(userId);
      if (user.enableNotifications) {
        const newNotif = await Notification.create({
          user: userId,
          title: "Subscription Purchased",
          message: `Welcome to ${subscriptionPayment.planId.name} plan! Enjoy your new benefits.`,
          type: "subscription_update",
        });
        io.to(userId.toString()).emit("newNotification", newNotif);
      }

      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "Subscription payment successful",
        data: {
          transactionId: paymentIntentId,
          planId: subscriptionPayment.planId._id,
          userSubId: userSub._id,
        },
      });
    } else {
      subscriptionPayment.paymentStatus = "failed";
      await subscriptionPayment.save();
      throw new AppError(httpStatus.BAD_REQUEST, "Payment failed.");
    }
  } catch (error) {
    console.error("Stripe confirm error:", error);
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
});
