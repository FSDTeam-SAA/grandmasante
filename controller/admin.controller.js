import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { Order } from "../model/order.model.js";
import { PaymentInfo } from "../model/payment.model.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

export const adminDashboard = catchAsync(async (req, res) => {
  const totalRevenueAgg = await PaymentInfo.aggregate([
    {
      $match: {
        paymentStatus: "complete",
        type: { $in: ["subscription", "product"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$finalPrice" } } },
  ]);
  const totalRevenue = totalRevenueAgg[0]?.total || 0;

  const totalUsers = await User.countDocuments({ role: { $ne: "admin" } });
  const commercialSales = await User.countDocuments({
    role: "commercial",
    status: "accepted",
  });
  const inHouseSales = await User.countDocuments({
    role: "in_house",
    status: "accepted",
  });

  const userJoiningOverview = await User.aggregate([
    { $match: { role: { $ne: "admin" } } },
    { $group: { _id: { $month: "$createdAt" }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const totalOrders = await Order.countDocuments({ status: "completed" });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Admin dashboard fetched successfully",
    data: {
      totalRevenue,
      totalUsers,
      commercialSales,
      inHouseSales,
      userJoiningOverview,
      totalOrders,
    },
  });
});
