import { Router } from "express";
import {
  adminDashboard,
  getUsers,
  getSubscriptionPlansAdmin,
  addSubscriptionPlan,
  updateSubscriptionPlan,
  toggleSubscriptionPlan,
} from "../controller/admin.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/dashboard", protect, adminDashboard);
router.get("/users", protect, getUsers);
router.get("/subscriptions", protect, getSubscriptionPlansAdmin);
router.post("/subscriptions", protect, addSubscriptionPlan);
router.put("/subscriptions/:id", protect, updateSubscriptionPlan);
router.patch("/subscriptions/:id", protect, toggleSubscriptionPlan);

export default router;
