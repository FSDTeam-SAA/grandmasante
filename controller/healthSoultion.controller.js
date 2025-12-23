import AppError from "../errors/AppError.js";
import { HealthSolution } from "../model/healthSoultion.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import OpenAI from "openai";
// const HealthSolution = require("../models/healthSolution.model");
// const catchAsync = require("../utils/catchAsync");
// const sendResponse = require("../utils/sendResponse");
// const AppError = require("../utils/AppError");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildPrompt(payload) {
  const { symptoms, additionalInfo, freeText } = payload;

  const country = additionalInfo?.country || "Unknown";

  return `
You are a cautious health triage assistant for a "natural remedies" app.

Goal:
Generate safe, conservative, culturally appropriate **natural remedies** and **tests** based on the user's symptoms and profile.

CRITICAL LOCAL AVAILABILITY RULE (MUST FOLLOW):
- The user’s country is: "${country}"
- Recommend remedies ONLY using ingredients that are **commonly available in ${country}** (typical grocery/pharmacy/market items).
- If an ingredient is not commonly available in ${country}, DO NOT suggest it.
- If you are uncertain whether something is commonly available in ${country}, choose a more universal alternative (e.g., warm water, honey, salt, ginger, turmeric, lemon if commonly available).
- Do NOT suggest exotic supplements, rare herbs, or branded products that may not exist locally.
- Do NOT suggest anything illegal or unsafe.

SAFETY RULES (MUST FOLLOW):
- Do NOT diagnose. Provide possibilities only.
- Be conservative with dosage and include warnings (pregnancy, children, allergies, chronic disease).
- If symptoms could indicate an emergency, make that clear in redFlags and keep remedies minimal.
- Avoid interactions: no strong claims for serious diseases; no prescription medication advice.

User input:
- Symptoms: ${JSON.stringify(symptoms)}
- Profile: ${JSON.stringify(additionalInfo)}
- Extra note: ${freeText ? JSON.stringify(freeText) : '""'}

OUTPUT FORMAT:
You MUST return ONLY valid JSON following the exact schema below.
No markdown. No extra keys. No text outside JSON.

JSON schema:
{
  "possibleConditions": [
    { "name": "string", "confidence": 0.0, "rationale": "string" }
  ],
  "naturalRemedies": [
    {
      "name": "string",
      "tags": ["string"],
      "howToUse": "string",
      "notes": "string"
    }
  ],
  "recommendedTests": [
    { "name": "string", "reason": "string" }
  ],
  "redFlags": ["string"],
  "disclaimer": "string"
}

CONTENT RULES:
- possibleConditions: 5–8 items max. confidence 0..1.
- naturalRemedies: 5–8 items max.
  - Every remedy MUST be feasible in ${country}.
  - Prefer everyday kitchen items and basic pharmacy items available locally.
  - Include dosage-style tags (e.g., "1–2 cups/day", "after meals", "before bed").
  - howToUse must be step-by-step and short.
  - notes should mention key cautions (e.g., "Avoid if diabetic", "Not for infants").
- recommendedTests: 0–4 items (only if appropriate).
- redFlags: 2–6 items, urgent symptoms needing doctor/ER.
- disclaimer must clearly state this is AI guidance, not a diagnosis, and to consult a healthcare professional.
`.trim();
}


function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Sometimes the model returns extra text; try to extract first JSON object
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw e;
  }
}

function validateAiOutput(ai) {
  if (!ai || typeof ai !== "object") return false;
  if (!Array.isArray(ai.possibleConditions)) return false;
  if (!Array.isArray(ai.naturalRemedies)) return false;
  if (!Array.isArray(ai.recommendedTests)) return false;
  if (!Array.isArray(ai.redFlags)) return false;
  if (typeof ai.disclaimer !== "string") return false;
  return true;
}

/**
 * POST /api/v1/health-solutions
 * body: { symptoms: string[], additionalInfo: {...}, freeText?: string }
 */
export const createHealthSolution = catchAsync(async (req, res, next) => {
  const { symptoms, additionalInfo, freeText } = req.body || {};

  if (!symptoms || !Array.isArray(symptoms) || symptoms.length === 0) {
    return next(new AppError("Symptoms are required.", 400));
  }
  if (!additionalInfo) return next(new AppError("Additional info is required.", 400));

  const requiredFields = ["category", "sex", "bodyZone", "country"];
  for (const f of requiredFields) {
    if (!additionalInfo[f]) return next(new AppError(`additionalInfo.${f} is required.`, 400));
  }

  const prompt = buildPrompt({ symptoms, additionalInfo, freeText });

  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: "You output strict JSON only." },
      { role: "user", content: prompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || "";
  let ai;
  try {
    ai = safeJsonParse(raw);
  } catch (err) {
    return next(new AppError("AI returned invalid JSON. Try again.", 502));
  }

  if (!validateAiOutput(ai)) {
    return next(new AppError("AI response format mismatch. Try again.", 502));
  }

  const doc = await HealthSolution.create({
    user: req.user?.id, // optional if you have auth middleware
    input: { symptoms, additionalInfo, freeText },
    output: {
      possibleConditions: ai.possibleConditions,
      naturalRemedies: ai.naturalRemedies,
      recommendedTests: ai.recommendedTests,
      redFlags: ai.redFlags,
      disclaimer: ai.disclaimer,
    },
    aiMeta: {
      provider: "openai",
      model: "gpt-4.1-mini",
      promptVersion: "v1",
    },
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Health solution generated successfully.",
    data: doc,
  });
});

/**
 * GET /api/v1/health-solutions/:id
 */
export const getHealthSolution = catchAsync(async (req, res, next) => {
  const doc = await HealthSolution.findById(req.params.id);
  if (!doc) return next(new AppError("Health solution not found.", 404));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Health solution fetched successfully.",
    data: doc,
  });
});

/**
 * GET /api/v1/health-solutions (optional)
 */
export const getMyHealthSolutions = catchAsync(async (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) return next(new AppError("Unauthorized.", 401));

  const docs = await HealthSolution.find({ user: userId }).sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Your health solutions fetched successfully.",
    data: docs,
  });
});
