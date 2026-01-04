import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

export const getProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token"
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile fetched successfully",
    data: user,
  });
});

export const updateProfile = catchAsync(async (req, res) => {
  const { name, phone } = req.body;

  // Find user
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token"
  );
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  // Update profile fields
  if (name) user.name = name;
  if (phone) user.phone = phone;

  // Upload new photo if provided
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

export const getUsers = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, role, status } = req.query;

  const filter = {};

  if (role) {
    filter.role = role;
  }

  if (status) {
    filter.status = status;
  }

  const users = await User.paginate(filter, {
    page: Number(page),
    limit: Number(limit),
    select: "name email createdAt credit currentPlan status role",
    sort: { createdAt: -1 },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Users fetched successfully",
    data: users,
  });
});


export const giveCredit = catchAsync(async (req, res) => {
  const { userId, credits } = req.body;
  const user = await User.findById(userId);
  if (!user || user.role !== "in_house") {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid in_house user");
  }
  user.credit = (user.credit || 0) + (credits || 20);
  user.status = "accepted";
  await user.save();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Credits given and user accepted",
    data: user,
  });
});

export const acceptUser = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const user = await User.findByIdAndUpdate(
    userId,
    { status: "accepted" },
    { new: true }
  );
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User accepted",
    data: user,
  });
});

export const declineUser = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const user = await User.findByIdAndUpdate(
    userId,
    { status: "declined" },
    { new: true }
  );
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User declined",
    data: user,
  });
});
