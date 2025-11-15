import AppError from "../errors/AppError.js";
import { Message } from "../model/message.model.js";
import catchAsync from "../utils/catchAsync.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import sendResponse from "../utils/sendResponse.js";

const getConversationId = (userA, userB) => {
  return [userA.toString(), userB.toString()].sort().join("_");
};

export const sendMessage = catchAsync(async (req, res, next) => {
  const { receiverId, content, contentType } = req.body;
  const senderId = req.user._id;

  if (!receiverId) {
    return next(new AppError(400, "Receiver ID is required"));
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
    "name phone profileImage email"
  );

  const io = getIO();

  io.to(receiverId.toString()).emit("newMessage", {
    ...fullMessage.toObject(),
    isMe: false,
  });

  io.to(senderId.toString()).emit("messageSent", {
    ...fullMessage.toObject(),
    isMe: true,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Message sent",
    data: { ...fullMessage.toObject(), isMe: true },
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
    .populate("sender receiver", "name phone profileImage email")
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

export const getMessages = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const currentUser = req.user._id;

  const conversationId = getConversationId(currentUser, userId);

  const messages = await Message.find({ conversationId })
    .sort({ createdAt: -1 })
    .populate("sender receiver", "name phone profileImage email");

  const formatted = messages.map((msg) => ({
    ...msg.toObject(),
    isMe: msg.sender._id.toString() === currentUser.toString(),
  }));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Messages fetched",
    data: formatted,
  });
});
