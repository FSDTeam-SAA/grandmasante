import express from "express";
import {
  sendMessage,
  getChats,
  getMessages,
} from "../controller/message.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import upload from "../middleware/multer.middleware.js";

const router = express.Router();
router.use(protect);

router.post("/send", upload.array("files"), sendMessage);
router.get("/chats", getChats);
router.get("/:userId/messages", getMessages);

export default router;
