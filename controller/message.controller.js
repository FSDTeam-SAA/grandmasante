import AppError from "../errors/AppError.js";
import { Message } from "../model/message.model.js";
import { User } from "../model/user.model.js";
import { io, userSocketRoom } from "../server.js";
import catchAsync from "../utils/catchAsync.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import sendResponse from "../utils/sendResponse.js";

const getConversationId = (userA, userB) => {
  return [userA.toString(), userB.toString()].sort().join("_");
};

const userPopulateFields =
  "name phone avatar email country gender dob role currentPlan credit subscription";

const getSupportAdmin = async () => {
  if (process.env.SUPPORT_ADMIN_ID) {
    const configuredAdmin = await User.findOne({
      _id: process.env.SUPPORT_ADMIN_ID,
      role: "admin",
    });

    if (configuredAdmin) return configuredAdmin;
  }

  return User.findOne({ role: "admin" }).sort({ createdAt: 1 });
};

const emitMessage = (userId, event, message) => {
  io.to(userSocketRoom(userId.toString())).emit(event, message);
};

const formatMessage = (msg, currentUserId) => ({
  ...msg.toObject(),
  isMe: msg.sender._id.toString() === currentUserId.toString(),
});

export const sendMessage = catchAsync(async (req, res, next) => {
  const { receiverId: requestedReceiverId, content, contentType } = req.body;
  const senderId = req.user._id;
  let receiverId = requestedReceiverId;

  if (req.user.role !== "admin") {
    const supportAdmin = await getSupportAdmin();
    if (!supportAdmin) {
      return next(new AppError(404, "Support admin not found"));
    }
    receiverId = supportAdmin._id;
  }

  if (!receiverId) {
    return next(new AppError(400, "Receiver ID is required"));
  }

  if (senderId.toString() === receiverId.toString()) {
    return next(new AppError(400, "You cannot send a message to yourself"));
  }

  const receiver = await User.findById(receiverId).select("_id role");
  if (!receiver) {
    return next(new AppError(404, "Receiver not found"));
  }

  const conversationId = getConversationId(senderId, receiverId);

  // Upload files if any
  let fileUrls = [];
  if (req.files && req.files.length > 0) {
    const uploadedFiles = await Promise.all(
      req.files.map(async (file) => {
        const mimeMain = file.mimetype.split("/")[0];
        const resourceType = ["image", "video", "audio"].includes(mimeMain)
          ? mimeMain
          : "auto";

        const result = await uploadOnCloudinary(file.buffer, {
          resource_type: resourceType,
        });

        return {
          url: result.secure_url,
          content: resourceType,
          name: file.originalname,
        };
      })
    );

    fileUrls = uploadedFiles;
  }

  const message = await Message.create({
    conversationId,
    sender: senderId,
    receiver: receiverId,
    content: content || "",
    contentType: contentType || (fileUrls.length > 0 ? "file" : "text"),
    fileUrl: fileUrls,
  });

  const fullMessage = await Message.findById(message._id).populate(
    "sender receiver",
    userPopulateFields
  );

  const receiverPayload = {
    ...fullMessage.toObject(),
    isMe: false,
  };
  const senderPayload = {
    ...fullMessage.toObject(),
    isMe: true,
  };

  emitMessage(receiverId, "newMessage", receiverPayload);
  emitMessage(senderId, "messageSent", senderPayload);

  if (req.user.role !== "admin") {
    io.to("admin").emit("newMessage", receiverPayload);
  }

  if (receiver.role === "admin" || req.user.role !== "admin") {
    io.to("admin").emit("chatUpdated", receiverPayload);
  }

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Message sent",
    data: senderPayload,
  });
});

export const getChats = catchAsync(async (req, res, next) => {
  const userId = req.user._id.toString();

  const lastMessages = await Message.aggregate([
    {
      $match: {
        $or: [{ sender: req.user._id }, { receiver: req.user._id }],
      },
    },
    {
      $sort: { createdAt: -1 },
    },
    {
      $group: {
        _id: "$conversationId",
        lastMessageId: { $first: "$_id" },
      },
    },
  ]);

  const ids = lastMessages.map((x) => x.lastMessageId);

  let chats = await Message.find({ _id: { $in: ids } })
    .populate("sender receiver", userPopulateFields)
    .sort({ createdAt: -1 });

  chats = chats.map((msg) => {
    const other =
      msg.sender._id.toString() === userId ? msg.receiver : msg.sender;

    return {
      conversationId: msg.conversationId,
      user: other,
      lastMessage: msg,
      isMe: msg.sender._id.toString() === userId,
    };
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Chats fetched",
    data: chats,
  });
});

export const getAdminChats = catchAsync(async (req, res, next) => {
  if (req.user.role !== "admin") {
    return next(new AppError(403, "Only admins can fetch followup chats"));
  }

  const admins = await User.find({ role: "admin" }).select("_id");
  const adminIds = admins.map((admin) => admin._id);

  const lastMessages = await Message.aggregate([
    {
      $match: {
        $or: [{ sender: { $in: adminIds } }, { receiver: { $in: adminIds } }],
      },
    },
    {
      $sort: { createdAt: -1 },
    },
    {
      $group: {
        _id: "$conversationId",
        lastMessageId: { $first: "$_id" },
      },
    },
  ]);

  const ids = lastMessages.map((x) => x.lastMessageId);

  let chats = await Message.find({ _id: { $in: ids } })
    .populate("sender receiver", userPopulateFields)
    .sort({ createdAt: -1 });

  chats = chats.map((msg) => {
    const senderIsAdmin = msg.sender.role === "admin";
    const user = senderIsAdmin ? msg.receiver : msg.sender;

    return {
      conversationId: msg.conversationId,
      user,
      lastMessage: msg,
      isMe: msg.sender._id.toString() === req.user._id.toString(),
    };
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Admin followup chats fetched",
    data: chats,
  });
});

export const getFollowupMessages = catchAsync(async (req, res, next) => {
  const supportAdmin = await getSupportAdmin();
  if (!supportAdmin) {
    return next(new AppError(404, "Support admin not found"));
  }

  const conversationId = getConversationId(req.user._id, supportAdmin._id);

  const messages = await Message.find({ conversationId })
    .sort({ createdAt: 1 })
    .populate("sender receiver", userPopulateFields);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Followup messages fetched",
    data: messages.map((msg) => formatMessage(msg, req.user._id)),
  });
});

export const getMessages = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const currentUser = req.user._id;

  if (req.user.role !== "admin") {
    const supportAdmin = await getSupportAdmin();
    if (!supportAdmin || userId !== supportAdmin._id.toString()) {
      return next(new AppError(403, "You can only fetch your followup chat"));
    }
  }

  const conversationId = getConversationId(currentUser, userId);

  const messages = await Message.find({ conversationId })
    .sort({ createdAt: 1 })
    .populate("sender receiver", userPopulateFields);

  const formatted = messages.map((msg) => formatMessage(msg, currentUser));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Messages fetched",
    data: formatted,
  });
});
