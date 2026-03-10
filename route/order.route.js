import express from "express";
import {
  createPaymentForProduct,
  confirmCheckoutPayment,
  getOrders,
  updateOrderStatus,
  deleteOrder,
  getSingleOrder,
  getOrdersByStatus,
} from "../controller/order.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/checkout", protect, createPaymentForProduct); // Query: ?useCart=true|false; Body for direct products if false
router.post("/confirm-checkout", protect, confirmCheckoutPayment); // Body: {transactionId|reference}

// Order retrieval (authenticated)
router.get("/", protect, getOrders);
router.get("/:id", protect, getSingleOrder);

// Admin order management
router.get(
  "/status/:status",
  protect,

  getOrdersByStatus
);
router.put("/:id", protect, updateOrderStatus);
router.delete("/:id", protect, deleteOrder);

export default router;
