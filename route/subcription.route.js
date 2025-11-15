import express from "express";
import {
  getSubscriptionPlans,
  getSubscriptionPlansAdmin,
  addSubscriptionPlan,
  updateSubscriptionPlan,
  toggleSubscriptionPlan,
  createSubscriptionPayment,
  confirmSubscriptionPayment,
} from "../controller/subcription.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// Public plan retrieval
router.get("/plans", getSubscriptionPlans);

// Admin plan management
router.get("/plans/admin", protect, getSubscriptionPlansAdmin);
router.post("/plans", protect, addSubscriptionPlan);
router.put("/plans/:id", protect, updateSubscriptionPlan);
router.post("/plans/:id/toggle", protect, toggleSubscriptionPlan); // Body: {action: "active"|"delete"}

// User subscription payment
router.post("/create-payment", protect, createSubscriptionPayment); // Body: {planId}
router.post("/confirm-payment", protect, confirmSubscriptionPayment); // Body: {paymentIntentId, paymentMethodId}

export default router;
