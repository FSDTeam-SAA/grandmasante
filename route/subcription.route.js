import { Router } from "express";
import {
  getSubscriptionPlans,
  confirmSubscriptionPayment,
  createSubscriptionPayment,
} from "../controller/subcription.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/", protect, getSubscriptionPlans);
router.post("/create-payment-intent", protect, createSubscriptionPayment);
router.post("/confirm-payment", protect, confirmSubscriptionPayment);

export default router;
