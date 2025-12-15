import { Router } from "express";
import { adminDashboard } from "../controller/admin.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/dashboard", protect, adminDashboard);

export default router;
