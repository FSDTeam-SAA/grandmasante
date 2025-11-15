import express from "express";

import authRoute from "../route/auth.route.js";
import userRoute from "../route/user.route.js";
import subscriptionRoute from "../route/subcription.route.js";
import notificationRoute from "../route/notification.route.js";
import adminRoute from "../route/admin.route.js";
import messageRoute from "../route/message.route.js";
import productRoute from "../route/product.route.js";
import cartRoute from "../route/cart.route.js";
import orderRoute from "../route/order.route.js";

const router = express.Router();

// Mounting the routes
router.use("/auth", authRoute);
router.use("/user", userRoute);
router.use("/subscription", subscriptionRoute);
router.use("/notifications", notificationRoute);
router.use("/admin", adminRoute);
router.use("/messages", messageRoute);
router.use("/products", productRoute);
router.use("/cart", cartRoute);
router.use("/orders", orderRoute);

export default router;
