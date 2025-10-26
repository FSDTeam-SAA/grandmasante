import mongoose from "mongoose";
import { Chat } from "../models/chat.model.js";
import { Message } from "../models/message.model.js";
import { sendResponse, uploadOnCloudinary } from "../utility/helper.js";
import AppError from "../errors/appError.js";
import catchAsync from "../utility/catchAsync.js";
import { getIO } from "../app.js";

const publicUserFields = "name phone profileImage email";

export const createChat = catchAsync(async (req, res, next) => {
  const { participantId } = req.body;
  const userId = req.user._id;

  if (!participantId) {
    return next(new AppError(400, "Participant ID is required"));
  }

  let chat = await Chat.findOne({
    participants: { $all: [userId, participantId], $size: 2 },
  })
    .populate("participants", publicUserFields)
    .populate({
      path: "lastMessage",
      populate: { path: "sender", select: publicUserFields },
    });

  if (!chat) {
    chat = await Chat.create({
      participants: [userId, participantId],
    });

    chat = await Chat.findById(chat._id)
      .populate("participants", publicUserFields)
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: publicUserFields },
      });

    const chatTitle = chat.participants
      .filter((p) => p._id.toString() !== userId.toString())
      .map((p) => p.name || p.phone || "")
      .join(", ");
    chat.title = chatTitle;

    if (chat.lastMessage) {
      const lastMessage = chat.lastMessage.toObject();
      lastMessage.isMe =
        lastMessage.sender._id.toString() === userId.toString();
      chat = chat.toObject();
      chat.lastMessage = lastMessage;
    }

    const io = getIO();
    chat.participants.forEach((participant) => {
      io.to(participant._id.toString()).emit("newChat", chat);
    });
  }

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Chat created successfully",
    data: chat,
  });
});

export const sendMessage = catchAsync(async (req, res, next) => {
  let { chatId, content, contentType } = req.body;
  const sender = req.user._id;

  if (!chatId || (!content && !(req.files && req.files.length > 0))) {
    return next(new AppError(400, "Chat ID and content or files are required"));
  }

  const chat = await Chat.findById(chatId).populate(
    "participants",
    publicUserFields
  );
  if (!chat) {
    return next(new AppError(404, "Chat not found"));
  }

  // handle file uploads jodi jekono kichu hoy
  let fileUrls = [];
  if (req.files && req.files.length > 0) {
    const uploadPromises = req.files.map(async (file) => {
      const mimeMain = file.mimetype ? file.mimetype.split("/")[0] : "";
      const resourceType =
        mimeMain === "image" || mimeMain === "video" || mimeMain === "audio"
          ? mimeMain
          : "auto";

      const uploadOptions = { resource_type: resourceType };
      const result = await uploadOnCloudinary(file.buffer, uploadOptions);

      return {
        url: result.secure_url,
        content: result.resource_type || resourceType,
        name: file.originalname,
      };
    });

    fileUrls = await Promise.all(uploadPromises);
  }

  // create message
  const message = await Message.create({
    chatId,
    sender,
    content: content || "",
    contentType: contentType || (fileUrls.length > 0 ? "file" : "text"),
    fileUrl: fileUrls.length > 0 ? fileUrls : undefined,
  });

  chat.lastMessage = message._id;
  await chat.save();

  const fullMessageDoc = await Message.findById(message._id).populate(
    "sender",
    publicUserFields
  );

  const fullMessage = fullMessageDoc.toObject();

  const io = getIO();
  const recipients = chat.participants.filter(
    (p) => p._id.toString() !== sender.toString()
  );

  recipients.forEach((recipient) => {
    io.to(recipient._id.toString()).emit("newMessage", {
      ...fullMessage,
      isMe: fullMessageDoc.sender._id.toString() === recipient._id.toString(),
    });
  });

  io.to(sender.toString()).emit("messageSent", {
    ...fullMessage,
    isMe: true,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Message sent successfully",
    data: fullMessage,
  });
});

export const getChats = catchAsync(async (req, res, next) => {
  const userId = req.user._id;

  const chats = await Chat.find({
    participants: userId,
  })
    .populate("participants", publicUserFields)
    .populate({
      path: "lastMessage",
      populate: { path: "sender", select: publicUserFields },
    })
    .sort({ updatedAt: -1 });

  const activeChats = [];
  const nonActiveChats = [];

  for (const chat of chats) {
    const chatObj = chat.toObject ? chat.toObject() : chat;
    const chatTitle = chat.participants
      .filter((p) => p._id.toString() !== userId.toString())
      .map((p) => p.name || p.phone || "")
      .join(", ");
    chatObj.title = chatTitle;

    const hasMessage = await Message.exists({ chatId: chat._id });

    if (hasMessage) {
      const lastMessage = await Message.findOne({ chatId: chat._id })
        .sort({ createdAt: -1 })
        .populate("sender", publicUserFields)
        .lean();

      if (lastMessage) {
        lastMessage.isMe =
          lastMessage.sender._id.toString() === userId.toString();
        chatObj.lastMessage = lastMessage;
      }
      activeChats.push(chatObj);
    } else {
      nonActiveChats.push(chatObj);
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Chats retrieved successfully",
    data: { activeChats, nonActiveChats },
  });
});

export const getMessages = catchAsync(async (req, res, next) => {
  const { chatId } = req.params;
  const { limit = 30, before } = req.query;

  if (!mongoose.Types.ObjectId.isValid(chatId)) {
    return next(new AppError(400, "Invalid chatId"));
  }

  const query = { chatId };

  if (before) {
    if (mongoose.Types.ObjectId.isValid(before)) {
      query._id = { $lt: before };
    } else if (!isNaN(Date.parse(before))) {
      query.createdAt = { $lt: new Date(before) };
    } else {
      return next(new AppError(400, "Invalid 'before' parameter"));
    }
  }

  let messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .populate("sender", publicUserFields);

  const currentUserId = req.user._id.toString();

  const updatedMessages = messages.map((msg) => {
    const m = msg.toObject();
    m.isMe = msg.sender._id.toString() === currentUserId;
    return m;
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Messages retrieved successfully",
    data: updatedMessages,
  });
});
