import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { Product } from "../model/product.model.js";
import { Notification } from "../model/notification.model.js";
import { SubscriptionPlan } from "../model/subcriptionPlan.model.js";

export const getDashboard = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).populate("subscription");
  const totalItems =
    (user.savedItems.length || 0) + (user.purchases.length || 0);
  const totalValuesAgg = await Product.aggregate([
    { $match: { user: req.user._id } },
    { $group: { _id: null, total: { $sum: "$homePrice" } } },
  ]);
  const totalValues = totalValuesAgg[0]?.total || 0;
  const unreadNotifications = await Notification.countDocuments({
    user: req.user._id,
    isRead: false,
  });

  const plan = await SubscriptionPlan.findOne({ name: user.currentPlan });
  const showAds = plan?.hasAds || false;
  const remainingItems = plan.maxItems - totalItems;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard fetched successfully",
    data: {
      totalItems,
      totalValues,
      totalSavings: user.totalSavings,
      avgSavings: user.avgSavings,
      currentPlan: user.currentPlan,
      subscription: user.subscription,
      unreadNotifications,
      showAds,
      planLimits: {
        maxItems: plan.maxItems,
        remainingItems,
        maxCurrencies: plan.maxCurrencies,
      },
    },
  });
});

// Get user profile
export const getProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token"
  );
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile fetched successfully",
    data: user,
  });
});

// Update profile
export const updateProfile = catchAsync(async (req, res) => {
  const { name, localTax } = req.body;

  // Find user
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token"
  );
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  // Update only provided fields
  if (name) user.name = name;
  if (localTax) user.localTax = localTax;

  console.log(req.file);

  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    user.avatar.public_id = result.public_id;
    user.avatar.url = result.secure_url;
  }

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile updated successfully",
    data: user,
  });
});

// Change user password
export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.user._id).select("+password");
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (newPassword !== confirmPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "New password and confirm password do not match"
    );
  }

  if (!(await User.isPasswordMatched(currentPassword, user.password))) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Current password is incorrect"
    );
  }

  user.password = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed successfully",
    data: user,
  });
});
