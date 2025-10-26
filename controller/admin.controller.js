import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { SubscriptionPlan } from "../model/subcriptionPlan.model.js";
import { UserSubscription } from "../model/userSubcription.model.js";
import { Coupon } from "../model/coupon.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { PaymentInfo } from "../model/payment.model.js";

export const adminDashboard = catchAsync(async (req, res) => {
  const totalSubscriptions = await UserSubscription.countDocuments({
    status: "active",
  });

  const totalCoupons = await Coupon.countDocuments({ status: "active" });

  const totalSalesAgg = await UserSubscription.aggregate([
    { $match: { status: "active" } },
    {
      $lookup: {
        from: "subscriptionplans",
        localField: "plan",
        foreignField: "_id",
        as: "plan",
      },
    },
    { $unwind: "$plan" },
    { $group: { _id: null, total: { $sum: "$plan.priceYearly" } } },
  ]);
  const totalSales = totalSalesAgg[0]?.total || 0;

  const { period = "month" } = req.query; // "week" | "month" | "year"
  const match = { status: "active" };

  let overviewData;

  if (period === "year") {
    overviewData = await UserSubscription.aggregate([
      { $match: match },
      { $group: { _id: { $year: "$startDate" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    overviewData = overviewData.map((d) => ({
      year: d._id,
      count: d.count,
    }));
  } else if (period === "week") {
    overviewData = await UserSubscription.aggregate([
      {
        $match: {
          ...match,
          startDate: {
            $gte: new Date(new Date().getFullYear(), 0, 1),
          },
        },
      },
      {
        $group: {
          _id: { $isoWeek: "$startDate" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const weeksInYear = 52;
    const filledWeeks = Array.from({ length: weeksInYear }, (_, i) => {
      const found = overviewData.find((d) => d._id === i + 1);
      return {
        week: `Week ${i + 1}`,
        count: found ? found.count : 0,
      };
    });
    overviewData = filledWeeks;
  } else {
    overviewData = await UserSubscription.aggregate([
      { $match: match },
      { $group: { _id: { $month: "$startDate" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const filledMonths = months.map((m, idx) => {
      const found = overviewData.find((d) => d._id === idx + 1);
      return {
        month: m,
        count: found ? found.count : 0,
      };
    });
    overviewData = filledMonths;
  }

  const totalPayments = await PaymentInfo.countDocuments();
  const pendingPayments = await PaymentInfo.countDocuments({
    paymentStatus: "pending",
  });
  const failedPayments = await PaymentInfo.countDocuments({
    paymentStatus: "failed",
  });

  const paymentOverview = await PaymentInfo.aggregate([
    {
      $match: { createdAt: { $gte: new Date(new Date().getFullYear(), 0, 1) } },
    },
    {
      $group: {
        _id: { $month: "$createdAt" },
        count: { $sum: 1 },
        success: {
          $sum: { $cond: [{ $eq: ["$paymentStatus", "complete"] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin dashboard fetched successfully",
    data: {
      totalSubscriptions,
      totalCoupons,
      totalSales,
      overviewData,
      totalPayments,
      pendingPayments,
      failedPayments,
      paymentOverview,
    },
  });
});

export const getUsers = catchAsync(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const users = await User.paginate(
    {},
    {
      page: parseInt(page),
      limit: parseInt(limit),
      populate: {
        path: "subscription",
        populate: { path: "plan", select: "priceMonthly priceYearly" },
      },
      select: "name email createdAt currentPlan subscription.status",
    }
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Users fetched successfully",
    data: users,
  });
});

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
  if (req.body.priceMonthly === 0) {
    req.body.hasAds = true;
    req.body.maxItems = 5;
    req.body.maxCurrencies = 1;
  }
  const plan = await SubscriptionPlan.create(req.body);
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
  } else if (action === "inactive") {
    plan = await SubscriptionPlan.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
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
