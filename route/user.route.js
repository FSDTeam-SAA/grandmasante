import express from "express";
import {
  getProfile,
  updateProfile,
  getUsers,
  giveCredit,
  acceptUser,
  declineUser,
} from "../controller/user.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import upload from "./../middleware/multer.middleware.js";

const router = express.Router();

// User profile routes (authenticated)
router.get("/profile", protect, getProfile);
router.put("/profile", protect, upload.single("avatar"), updateProfile);

// Admin user management routes
router.get("/users", protect, getUsers);
router.post("/give-credit", protect, giveCredit);
router.post("/accept-user", protect, acceptUser);
router.post("/decline-user", protect, declineUser);

export default router;
