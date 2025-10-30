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

export const getSubscriptionPlans = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).select(
    "name priceMonthly priceYearly credits benefits hasAds"
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans,
  });
});

// Admin CRUD for plans
export const getSubscriptionPlansAdmin = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find().select("-__v");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans,
  });
});

export const addSubscriptionPlan = catchAsync(async (req, res) => {
  const { name, priceMonthly, priceYearly, credits, benefits, hasAds } =
    req.body;
  const defaultBenefits = {
    Basic:
      "Buy the plan and get guidance from a specialist through text messages.",
    Premium:
      "Buy the plan for expert guidance through phone calls every 5 days.",
    Extreme: "Buy the plan for expert calls and in-person visits.",
  };
  const planData = {
    name,
    priceMonthly,
    priceYearly,
    credits,
    benefits: benefits || [defaultBenefits[name]],
    hasAds: hasAds || name === "Basic",
  };
  const plan = await SubscriptionPlan.create(planData);
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Plan added successfully",
    data: plan,
  });
});

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

export const toggleSubscriptionPlan = catchAsync(async (req, res) => {
  const { action } = req.body;
  let plan;
  if (action === "delete") {
    plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
  } else {
    plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { isActive: action === "active" },
      { new: true }
    );
  }
  if (!plan) throw new AppError(httpStatus.NOT_FOUND, "Plan not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Plan ${action}d successfully`,
    data: plan,
  });
});

export const createSubscriptionPayment = catchAsync(async (req, res) => {
  const { planId } = req.body;
  const userId = req.user._id;
  const user = await User.findById(userId);

  if (!planId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Plan ID is required");
  }

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) {
    throw new AppError(httpStatus.NOT_FOUND, "Plan not found");
  }

  const finalPrice = plan.price;
  const discount = 0;

  let customer;
  try {
    customer = await stripeInstance.customers.create({
      email: user.email,
      metadata: {
        userId: userId.toString(),
      },
    });
  } catch (error) {
    const customers = await stripeInstance.customers.list({
      email: user.email,
    });
    customer = customers.data[0];
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
    },
  });

  const subscriptionPayment = new PaymentInfo({
    userId,
    planId,
    price: finalPrice,
    discount,
    finalPrice,
    transactionId: paymentIntent.id,
    paymentStatus: "pending",
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

      // Create UserSubscription on success (1 month validity)
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);

      const userSub = await UserSubscription.create({
        user: userId,
        plan: subscriptionPayment.planId._id,
        creditsUsed: 0,
        startDate,
        endDate,
        status: "active",
        paymentMethod: "stripe",
        stripeSubscriptionId: paymentIntentId,
      });

      // Update user with plan and add credits
      await User.findByIdAndUpdate(userId, {
        currentPlan: subscriptionPayment.planId.name,
        subscription: userSub._id,
        $inc: { credit: subscriptionPayment.planId.credits || 0 },
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
