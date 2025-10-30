import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

export const getUsers = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, role, status } = req.query;
  const filter = {
    role: { $in: role ? [role] : ["commercial", "in_house"] },
    status,
  };
  const users = await User.paginate(filter, {
    page: parseInt(page),
    limit: parseInt(limit),
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
  if (!user || user.role !== "commercial") {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid commercial user");
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
