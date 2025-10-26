import { Router } from "express";
import {
  getNotifications,
  markAsRead,
} from "../controller/notification.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/", protect, getNotifications);
router.patch("/read", protect, markAsRead);

export default router;
