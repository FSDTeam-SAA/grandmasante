import express from "express";
import { manageCart, clearCart } from "../controller/cart.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// Cart management (all actions via POST body: {productId, quantity, action})
router.post("/", protect, manageCart);

// Clear cart
router.post("/clear-cart", protect, clearCart);

export default router;
