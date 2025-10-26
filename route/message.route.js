import express from "express";
import {
  createChat,
  sendMessage,
  getChats,
  getMessages,
} from "../controllers/message.controller.js";
import { isAuthenticated } from "../middlewares/auth.middlewares.js";
import upload from "../middlewares/multer.middlewares.js";

const router = express.Router();
router.use(isAuthenticated);

router.post("/create", createChat);
router.post("/:chatId/message", upload.array("files"), sendMessage);
router.get("/", getChats);
router.get("/:chatId/messages", getMessages);

export default router;
