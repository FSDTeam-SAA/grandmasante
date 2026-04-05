import httpStatus from "http-status";
import { SubscriptionPlan } from "../model/subcriptionPlan.model.js";
import { UserSubscription } from "../model/userSubcription.model.js";
import { User } from "../model/user.model.js";
import { Notification } from "../model/notification.model.js";
import { io } from "../server.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { PaymentInfo } from "../model/payment.model.js";
import {
  amountToMinorUnit,
  createNotchPayPaymentLink,
  getNotchPayStatus,
  getNotchPayTransaction,
  isNotchPayFailureStatus,
  retrieveNotchPayPaymentByReferences,
} from "../utils/notchpay.service.js";
import {
  CURRENCY_DISPLAY,
  NOTCHPAY_CURRENCY,
} from "../utils/pricing.js";

const buildReference = (prefix, userId) =>
  `${prefix}_${userId}_${Date.now()}`;

const getPaymentCustomer = (user) => ({
  name: user?.name || user?.username || "Customer",
  email: user?.email,
  phone: user?.phone,
});

const getSubscriptionCallbackUrl = () =>
  process.env.NOTCHPAY_SUBSCRIPTION_CALLBACK_URL ||
  process.env.NOTCHPAY_CALLBACK_URL ||
  process.env.CLIENT_URL;

const serializePlan = (plan) => {
  const plainPlan = plan?.toObject ? plan.toObject() : plan;
  if (!plainPlan) return plainPlan;

  return {
    ...plainPlan,
    currency: NOTCHPAY_CURRENCY,
    currencyDisplay: CURRENCY_DISPLAY,
  };
};

// Get all active plans
export const getSubscriptionPlans = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).select(
    "name description price savePercentage userLimit carryCredit"
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans.map((plan) => serializePlan(plan)),
  });
});

// Create NotchPay payment link for subscription
export const createSubscriptionPayment = catchAsync(async (req, res) => {
  const { planId } = req.body;
  if (!planId)
    throw new AppError(httpStatus.BAD_REQUEST, "Plan ID is required");

  const userId = req.user._id;
  const user = await User.findById(userId);
  if (!user)
    throw new AppError(httpStatus.NOT_FOUND, "User not found");

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

  const transactionReference = buildReference("sub", userId.toString());
  const amountInMinorUnit = amountToMinorUnit(plan.price, NOTCHPAY_CURRENCY);

  let notchPayPayment;
  try {
    notchPayPayment = await createNotchPayPaymentLink({
      amount: amountInMinorUnit,
      currency: NOTCHPAY_CURRENCY,
      reference: transactionReference,
      callback: getSubscriptionCallbackUrl(),
      description: `Subscription payment for ${plan.name}`,
      customer: getPaymentCustomer(user),
      metadata: {
        type: "subscription",
        userId: userId.toString(),
        planId: plan._id.toString(),
      },
    });
  } catch (error) {
    throw new AppError(
      error?.statusCode || httpStatus.BAD_GATEWAY,
      error?.message || "Failed to create NotchPay payment link"
    );
  }

  const transaction = getNotchPayTransaction(notchPayPayment.response);

  // Save payment record
  const subscriptionPayment = await PaymentInfo.create({
    userId,
    planId,
    price: plan.price,
    finalPrice: plan.price,
    currency: NOTCHPAY_CURRENCY,
    transactionId: transactionReference,
    providerTransactionId: transaction?.id || null,
    gatewayReference: transaction?.reference || transaction?.id || null,
    paymentStatus: "pending",
    paymentMethod: "notchpay",
    type: "subscription",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Subscription payment link created",
    data: {
      transactionId: transactionReference,
      reference: transactionReference,
      paymentLink: notchPayPayment.authorizationUrl,
      currency: NOTCHPAY_CURRENCY,
      currencyDisplay: CURRENCY_DISPLAY,
      amountInMinorUnit,
      finalPrice: plan.price,
      status: getNotchPayStatus(notchPayPayment.response),
      providerTransactionId: transaction?.id || transaction?.reference || null,
      paymentId: subscriptionPayment._id,
    },
  });
});

// Confirm NotchPay payment and activate subscription
export const confirmSubscriptionPayment = catchAsync(async (req, res) => {
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

  if (!localReferenceCandidates.length)
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Transaction reference is required"
    );

  let subscriptionPayment = await PaymentInfo.findOne({
    userId,
    type: "subscription",
    transactionId: { $in: localReferenceCandidates },
  }).populate("planId");

  if (!subscriptionPayment && reference) {
    subscriptionPayment = await PaymentInfo.findOne({
      userId,
      type: "subscription",
      gatewayReference: reference,
    }).populate("planId");
  }

  if (!subscriptionPayment)
    throw new AppError(httpStatus.NOT_FOUND, "Payment record not found");

  const localTransactionReference = subscriptionPayment.transactionId;

  if (!subscriptionPayment.planId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Related subscription plan does not exist"
    );
  }

  if (subscriptionPayment.paymentStatus === "complete") {
    const existingUserSub = await UserSubscription.findOne({
      user: userId,
      plan: subscriptionPayment.planId._id,
      status: "active",
    });

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Subscription payment is already confirmed",
      data: {
        transactionId: localTransactionReference,
        planId: subscriptionPayment.planId._id,
        userSubId: existingUserSub?._id || null,
        creditsRemaining:
          existingUserSub?.creditsRemaining || subscriptionPayment.planId.carryCredit,
      },
    });
  }

  let notchPayResult;
  try {
    notchPayResult = await retrieveNotchPayPaymentByReferences([
      reference,
      subscriptionPayment.gatewayReference,
      subscriptionPayment.providerTransactionId,
      transactionId,
      paymentIntentId,
      trxref,
      notchpay_trxref,
      localTransactionReference,
    ]);
  } catch (error) {
    throw new AppError(
      error?.statusCode || httpStatus.BAD_GATEWAY,
      error?.message || "Failed to verify payment with NotchPay"
    );
  }
  const notchPayResponse = notchPayResult.response;
  const paymentStatus = String(getNotchPayStatus(notchPayResponse) || "").toLowerCase();
  const transaction = getNotchPayTransaction(notchPayResponse);

  if (paymentStatus === "complete") {
    subscriptionPayment.paymentStatus = "complete";
    subscriptionPayment.paymentMethod =
      transaction?.payment_method || transaction?.channel || "notchpay";
    subscriptionPayment.providerTransactionId =
      transaction?.id || subscriptionPayment.providerTransactionId || null;
    subscriptionPayment.gatewayReference =
      transaction?.reference ||
      notchPayResult.matchedReference ||
      subscriptionPayment.gatewayReference ||
      null;
    await subscriptionPayment.save();

    let userSub = await UserSubscription.findOne({
      user: userId,
      plan: subscriptionPayment.planId._id,
      status: "active",
    });

    if (!userSub) {
      userSub = await UserSubscription.create({
        user: userId,
        plan: subscriptionPayment.planId._id,
        creditsRemaining: subscriptionPayment.planId.carryCredit,
        status: "active",
        paymentMethod: "notchpay",
        stripeTransactionId: null,
        notchpayTransactionId:
          transaction?.id ||
          transaction?.reference ||
          notchPayResult.matchedReference ||
          localTransactionReference,
        gatewayTransactionId:
          transaction?.id ||
          transaction?.reference ||
          notchPayResult.matchedReference ||
          localTransactionReference,
      });

      await User.findByIdAndUpdate(userId, {
        currentPlan: subscriptionPayment.planId.name,
        subscription: userSub._id,
        credit: subscriptionPayment.planId.carryCredit,
      });

      const newNotif = await Notification.create({
        user: userId,
        title: "Subscription Purchased",
        message: `Your ${subscriptionPayment.planId.name} subscription is active with ${subscriptionPayment.planId.carryCredit} credits.`,
        type: "subscription",
      });

      io.emit("notification", newNotif);
    }

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Subscription activated successfully",
      data: {
        transactionId: localTransactionReference,
        planId: subscriptionPayment.planId._id,
        userSubId: userSub._id,
        creditsRemaining: userSub.creditsRemaining,
      },
    });
    return;
  }

  if (isNotchPayFailureStatus(paymentStatus)) {
    subscriptionPayment.paymentStatus = "failed";
    await subscriptionPayment.save();
    throw new AppError(httpStatus.BAD_REQUEST, "Payment failed");
  }

  sendResponse(res, {
    statusCode: httpStatus.ACCEPTED,
    success: true,
    message: "Payment is not completed yet",
    data: {
      transactionId: localTransactionReference,
      status: paymentStatus || "pending",
    },
  });
});

// Get all plans (admin)
export const getSubscriptionPlansAdmin = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Plans fetched successfully",
    data: plans.map((plan) => serializePlan(plan)),
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
    data: serializePlan(plan),
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
    data: serializePlan(plan),
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
    data: serializePlan(plan),
  });
});
