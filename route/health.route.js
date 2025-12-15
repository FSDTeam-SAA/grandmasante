import { Router } from "express";
import { createHealthSolution, getHealthSolution, getMyHealthSolutions } from "../controller/healthSoultion.controller.js";


const router = Router();

router.post("/", createHealthSolution);
router.get("/:id", getHealthSolution);
router.get("/", getMyHealthSolutions);

export default router;
