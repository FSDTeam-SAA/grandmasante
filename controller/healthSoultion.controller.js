import AppError from "../errors/AppError.js";
import { HealthSolution } from "../model/healthSoultion.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import {
  enrichNaturalRemediesWithImages,
  warmupRemedyImages,
} from "../utils/remedyImage.service.js";
import OpenAI from "openai";
// const HealthSolution = require("../models/healthSolution.model");
// const catchAsync = require("../utils/catchAsync");
// const sendResponse = require("../utils/sendResponse");
// const AppError = require("../utils/AppError");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LEGACY_CATEGORY_MAP = {
  "Adult (18-65)": "Adult (18-64)",
};

function normalizeAdditionalInfo(additionalInfo) {
  if (!additionalInfo || typeof additionalInfo !== "object") return additionalInfo;

  const normalized = { ...additionalInfo };
  if (typeof normalized.category === "string") {
    normalized.category = LEGACY_CATEGORY_MAP[normalized.category] || normalized.category;
  }

  return normalized;
}

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
  - howToUse MUST be 1–3 short plain-English sentences (NO labels like "Ingredients:"/"Steps:", NO bullets, NO numbering).
  - Include exact measured quantities using metric units (g, ml, L) directly inside the sentence flow.
  - Do not provide vague instructions like "some ginger" or "as needed".
  - Include both ingredient amount and liquid amount where applicable (e.g., "10 g ginger", "250 ml (0.25 L) water"), plus basic time guidance.
  - notes should mention key cautions (e.g., "Avoid if diabetic", "Not for infants").
- recommendedTests: 0–4 items (only if appropriate).
- redFlags: 2–6 items, urgent symptoms needing doctor/ER.
  - Must be specific danger signs related to the user's symptoms (not generic advice).
  - Each item should be one short, plain-English sentence.
  - Do not repeat the disclaimer in redFlags.
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

function cleanText(value) {
  return (value || "")
    .toString()
    .replace(/\s+/g, " ")
    .replace(/^[•\-–\s]+/, "")
    .trim();
}

function normalizeStringList(values) {
  const seen = new Set();
  const cleaned = [];

  for (const raw of Array.isArray(values) ? values : []) {
    const item = cleanText(raw);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(item);
  }

  return cleaned;
}

function buildFallbackRedFlags(symptoms) {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");

  const fallback = [];

  if (/headache|migraine/.test(symptomText)) {
    fallback.push("Sudden severe headache, fainting, confusion, or stiff neck.");
  }
  if (/fever|chills|temperature/.test(symptomText)) {
    fallback.push("Fever above 103°F (39.4°C), fever lasting more than 3 days, or severe weakness.");
  }
  if (/cough|breath|chest/.test(symptomText)) {
    fallback.push("Trouble breathing, chest pain, or blue lips/fingertips.");
  }

  fallback.push("Persistent vomiting, inability to keep fluids down, or signs of dehydration.");
  fallback.push("Symptoms getting rapidly worse instead of improving within 24–48 hours.");

  return normalizeStringList(fallback).slice(0, 6);
}

function normalizeRedFlags(redFlags, symptoms) {
  const cleaned = normalizeStringList(redFlags)
    .filter((item) => !/not a diagnosis|consult (a )?healthcare professional/i.test(item))
    .slice(0, 6);

  if (cleaned.length >= 2) return cleaned;

  const fallback = buildFallbackRedFlags(symptoms);
  const merged = normalizeStringList([...cleaned, ...fallback]).slice(0, 6);
  return merged.length ? merged : fallback.slice(0, 2);
}

const METRIC_QUANTITY_REGEX =
  /(\d+(\.\d+)?)\s?(g|gram|grams|kg|mg|ml|l|liter|liters|litre|litres)\b/i;

function hasMetricQuantity(text) {
  return METRIC_QUANTITY_REGEX.test(cleanText(text));
}

function ingredientFromName(remedyName) {
  const stopWords = new Set([
    "with",
    "and",
    "for",
    "tea",
    "water",
    "milk",
    "drink",
    "natural",
    "root",
  ]);

  const tokens = cleanText(remedyName)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !stopWords.has(t));

  return tokens[0] || "main ingredient";
}

function buildMeasuredIngredients(remedyName) {
  const normalized = cleanText(remedyName).toLowerCase();
  const ingredients = [];

  if (normalized.includes("milk")) {
    ingredients.push("250 ml (0.25 L) warm milk");
  } else {
    ingredients.push("250 ml (0.25 L) warm water");
  }

  if (normalized.includes("ginger")) ingredients.push("12 g fresh ginger");
  if (normalized.includes("turmeric")) ingredients.push("5 g turmeric powder");
  if (normalized.includes("honey")) ingredients.push("10 g honey");
  if (normalized.includes("lemon")) ingredients.push("15 ml fresh lemon juice");
  if (normalized.includes("salt")) ingredients.push("2 g salt");
  if (normalized.includes("garlic")) ingredients.push("6 g crushed garlic");
  if (normalized.includes("cinnamon")) ingredients.push("2 g cinnamon powder");

  if (ingredients.length <= 1) {
    ingredients.push(`8 g ${ingredientFromName(remedyName)}`);
  }

  return ingredients;
}

function buildFallbackHowToUse(remedy) {
  const remedyName = cleanText(remedy?.name || "natural remedy");
  const ingredients = buildMeasuredIngredients(remedyName);
  const isMilkBased = remedyName.toLowerCase().includes("milk");
  const primary = ingredients.find((item) => !/water|milk/i.test(item)) || ingredients[0];
  const baseLiquid = isMilkBased
    ? ingredients.find((item) => /milk/i.test(item)) || "250 ml (0.25 L) warm milk"
    : ingredients.find((item) => /water/i.test(item)) || "250 ml (0.25 L) water";
  const optionalSweetener = ingredients.find((item) => /honey/i.test(item));

  const sweetenerText = optionalSweetener ? ` and stir in ${optionalSweetener} at the end` : "";
  const heatAction = isMilkBased
    ? "heat gently for 2-3 minutes without boiling"
    : "simmer for 8-10 minutes";

  return `Add ${primary} to ${baseLiquid}, ${heatAction}${sweetenerText}, then drink warm.`;
}

function extractLegacySections(text) {
  const raw = (text || "").toString();
  const lowered = raw.toLowerCase();
  const ingredientsIndex = lowered.indexOf("ingredients:");
  const stepsIndex = lowered.indexOf("steps:");
  if (ingredientsIndex === -1 || stepsIndex === -1 || stepsIndex < ingredientsIndex) {
    return null;
  }

  const ingredientsText = raw
    .slice(ingredientsIndex + "ingredients:".length, stepsIndex)
    .trim();
  const stepsText = raw.slice(stepsIndex + "steps:".length).trim();

  return { ingredientsText, stepsText };
}

function splitAndCleanLegacyItems(text) {
  return (text || "")
    .split(/\n|,|;/)
    .map((item) => cleanText(item))
    .filter(Boolean)
    .map((item) => item.replace(/^\d+\s*[\).:-]?\s*/, "").trim());
}

function toSentenceListFromSteps(stepsText) {
  const normalizedSteps = (stepsText || "")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedSteps) return [];

  const rawParts = normalizedSteps
    .split(/\s*\d+\s*[\).:-]\s*/g)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (rawParts.length > 0) {
    return rawParts.map((part) => part.replace(/\.$/, "").trim());
  }

  return splitAndCleanLegacyItems(normalizedSteps)
    .map((part) => part.replace(/\.$/, "").trim())
    .filter(Boolean);
}

function buildNarrativeHowToUse(existing) {
  const legacy = extractLegacySections(existing);
  if (!legacy) return null;

  const ingredients = splitAndCleanLegacyItems(legacy.ingredientsText);
  const steps = toSentenceListFromSteps(legacy.stepsText);
  const intro = ingredients.length
    ? `Use ${ingredients.slice(0, 3).join(", ")}.`
    : "";

  const flow = steps
    .map((step, index) => {
      if (index === 0) return `${step}.`;
      return `Then ${step}.`;
    })
    .join(" ");

  return cleanText(`${intro} ${flow}`.trim());
}

function normalizeHowToUse(remedy) {
  const existingRaw = (remedy?.howToUse || "").toString().trim();
  if (!existingRaw) return buildFallbackHowToUse(remedy);

  const narrative = buildNarrativeHowToUse(existingRaw);
  if (narrative) return narrative;

  const cleanedExisting = cleanText(existingRaw)
    .replace(/\s*\d+\s*[\).:-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (hasMetricQuantity(cleanedExisting)) return cleanedExisting;

  return buildFallbackHowToUse(remedy);
}

function normalizeNaturalRemedies(remedies) {
  if (!Array.isArray(remedies)) return [];

  return remedies.map((remedy) => {
    const name = cleanText(remedy?.name) || "Natural Remedy";
    const tags = normalizeStringList(remedy?.tags);
    const notes = cleanText(remedy?.notes);

    return {
      ...remedy,
      name,
      tags,
      notes,
      howToUse: normalizeHowToUse({ ...remedy, name }),
    };
  });
}

/**
 * POST /api/v1/health-solutions
 * body: { symptoms: string[], additionalInfo: {...}, freeText?: string }
 */
export const createHealthSolution = catchAsync(async (req, res, next) => {
  const { symptoms, additionalInfo, freeText } = req.body || {};
  const normalizedAdditionalInfo = normalizeAdditionalInfo(additionalInfo);

  if (!symptoms || !Array.isArray(symptoms) || symptoms.length === 0) {
    return next(new AppError("Symptoms are required.", 400));
  }
  if (!normalizedAdditionalInfo) return next(new AppError("Additional info is required.", 400));

  const requiredFields = ["category", "sex", "bodyZone", "country"];
  for (const f of requiredFields) {
    if (!normalizedAdditionalInfo[f]) return next(new AppError(`additionalInfo.${f} is required.`, 400));
  }

  const prompt = buildPrompt({
    symptoms,
    additionalInfo: normalizedAdditionalInfo,
    freeText,
  });

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

  const normalizedRemedies = normalizeNaturalRemedies(ai.naturalRemedies);
  let enrichedRemedies = normalizedRemedies;
  try {
    // Keep request fast: attach cached images + at most one fresh generation.
    enrichedRemedies = await enrichNaturalRemediesWithImages(normalizedRemedies, {
      generateIfMissing: true,
      maxGenerateCount: 1,
      perImageTimeoutMs: 8000,
    });
    // Warm remaining images in background for future requests.
    warmupRemedyImages(normalizedRemedies).catch((error) => {
      console.error("[RemedyImage][Warmup] background error:", error?.message || error);
    });
  } catch (_) {
    enrichedRemedies = normalizedRemedies;
  }

  const normalizedRedFlags = normalizeRedFlags(ai.redFlags, symptoms);

  const doc = await HealthSolution.create({
    user: req.user?.id, // optional if you have auth middleware
    input: { symptoms, additionalInfo: normalizedAdditionalInfo, freeText },
    output: {
      possibleConditions: ai.possibleConditions,
      naturalRemedies: enrichedRemedies,
      recommendedTests: ai.recommendedTests,
      redFlags: normalizedRedFlags,
      disclaimer: ai.disclaimer,
    },
    aiMeta: {
      provider: "openai",
      model: "gpt-4.1-mini",
      promptVersion: "v4",
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
