import httpStatus from "http-status";
import { Notification } from "../model/notification.model.js";
import { io } from "../server.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

export const getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 10, type } = req.query;
  const filter = { user: req.user._id };
  if (type) filter.type = type;

  const notifications = await Notification.paginate(filter, {
    page: parseInt(page),
    limit: parseInt(limit),
    populate: "relatedProduct",
    options: { sort: { createdAt: -1 } },
  });

  await Notification.updateMany(filter, { isRead: true });
  io.to(req.user._id.toString()).emit("notificationsUpdated", {
    updated: true,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications fetched successfully",
    data: notifications,
  });
});

export const markAsRead = catchAsync(async (req, res) => {
  const { ids } = req.body;
  await Notification.updateMany(
    { _id: { $in: ids }, user: req.user._id },
    { isRead: true }
  );
  io.to(req.user._id.toString()).emit("notificationsUpdated", {
    updated: true,
  });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Notifications marked as read",
  });
});
