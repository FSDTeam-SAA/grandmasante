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
const HEALTH_AI_MODEL = process.env.HEALTH_AI_MODEL || "gpt-4.1";
const HEALTH_PROMPT_VERSION = "v6";

const HEALTH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    possibleConditions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["name", "confidence", "rationale"],
      },
    },
    naturalRemedies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          howToUse: { type: "string" },
          notes: { type: "string" },
        },
        required: ["name", "tags", "howToUse", "notes"],
      },
    },
    recommendedTests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "reason"],
      },
    },
    redFlags: {
      type: "array",
      items: { type: "string" },
    },
    emergencyAlert: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            message: { type: "string" },
          },
          required: ["title", "message"],
        },
      ],
    },
    disclaimer: { type: "string" },
  },
  required: [
    "possibleConditions",
    "naturalRemedies",
    "recommendedTests",
    "redFlags",
    "emergencyAlert",
    "disclaimer",
  ],
};

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

function normalizeSymptoms(symptoms) {
  return normalizeStringList(symptoms).slice(0, 12);
}

function normalizeFreeText(freeText) {
  return cleanText(freeText).slice(0, 1000);
}

function normalizeLanguage(language) {
  return cleanText(language).toLowerCase() === "en" ? "en" : "fr";
}

function buildPrompt(payload) {
  const { symptoms, additionalInfo, freeText, language } = payload;

  const country = additionalInfo?.country || "Unknown";
  const outputLanguage = language === "en" ? "English" : "French";

  return `
You are a cautious health triage assistant for a "natural remedies" app.

Goal:
Generate safer, more clinically plausible health guidance based only on the user's stated symptoms and profile. This is triage support, not diagnosis.

ACCURACY RULES (MUST FOLLOW):
- Treat the symptom list as incomplete. Do not assume missing details like duration, severity, exact location, pregnancy, fever, trauma, medications, or chronic diseases.
- Rank likely/common explanations before rare diagnoses unless the user's symptoms strongly suggest urgency.
- Keep confidence calibrated:
  - Single common symptom: top confidence may be 0.70-0.78 when the condition commonly matches that symptom.
  - 2-3 common symptoms: top confidence may be 0.75-0.85 when the pattern is plausible.
  - Use confidence above 0.90 only when the symptom pattern is very specific.
- Every condition rationale must explicitly connect to the provided symptom(s) in simple user-facing language.
- Do not mention missing details, uncertainty, lack of information, limited certainty, or incomplete symptom data in rationales.
- Do not list serious conditions as high confidence unless red-flag symptoms are present. Put urgent concerns in redFlags instead.
- Do not invent symptoms, diagnoses, lab results, medical history, or medication use.
- Use standard condition names. Do not invent hybrid names like "headache with mild infection" or combine unrelated possibilities into one condition.

CRITICAL LOCAL AVAILABILITY RULE (MUST FOLLOW):
- The user’s country is: "${country}"
- Recommend remedies ONLY using natural food, drink, rest, hydration, heat/steam, gargle, and simple home-care items commonly available in ${country}.
- If an ingredient is not commonly available in ${country}, DO NOT suggest it.
- If you are uncertain whether something is commonly available in ${country}, choose a more universal alternative (e.g., warm water, honey, salt, ginger, turmeric, lemon if commonly available).
- Do NOT suggest exotic supplements, rare herbs, or branded products that may not exist locally.
- Do NOT suggest anything illegal or unsafe.

SAFETY RULES (MUST FOLLOW):
- Do NOT diagnose. Provide possibilities only.
- Be conservative with dosage and include warnings (pregnancy, children, allergies, chronic disease).
- If symptoms could indicate an emergency, make that clear in redFlags and keep remedies minimal.
- If symptoms could indicate an emergency, make that clear in redFlags and keep remedies minimal but NOT empty. Include only immediate supportive care actions that are safe while urgent medical help is being arranged.
- Avoid interactions: no medicine advice, no prescription or over-the-counter drugs, no claims to cure infections or serious diseases, and no advice to delay urgent care.
- For infants, children, seniors, pregnancy/possible pregnancy, chest pain, breathing difficulty, neurological symptoms, severe abdominal pain, high fever, dehydration, blood in vomit/stool/urine, or rapidly worsening symptoms: prioritize redFlags and recommend medical care.
- If the user enters a likely diagnosis or disease name (for example: dengue, typhoid, jaundice, fracture, heart attack), keep conditions, tests, remedies, and safety messaging aligned to that illness or injury.
- If the user enters an injury or trauma symptom, do NOT mix in generic viral, hydration, stress, or diet-related conditions unless there is a clear reason.

User input:
- Symptoms: ${JSON.stringify(symptoms)}
- Profile: ${JSON.stringify(additionalInfo)}
- Extra note: ${freeText ? JSON.stringify(freeText) : '""'}
- Output language: ${outputLanguage}

OUTPUT FORMAT:
Return JSON only. No markdown. No extra keys. No text outside JSON.

LANGUAGE RULES:
- Write every user-facing string in ${outputLanguage}.
- That includes condition names, rationales, remedy names, tags, howToUse, notes, tests, redFlags, emergencyAlert, and disclaimer.
- Do not mix languages in the output.

CONTENT RULES:
- possibleConditions: 5-6 items. confidence 0..1.
  - Prefer useful, common possibilities over a long list.
  - Names should be plain language where possible.
  - Rationale should be 2 short user-facing sentences tied to the user's exact symptom pattern.
- naturalRemedies: 5-6 items.
  - Every remedy MUST be feasible in ${country}.
  - Natural Remedies MUST NOT include medicines, tablets, capsules, syrups, painkillers, antibiotics, antihistamines, decongestants, or supplements.
  - Do NOT suggest paracetamol, acetaminophen, ibuprofen, aspirin, naproxen, cetirizine, antibiotics, ORS packets, vitamins, zinc, or branded products.
  - Prefer everyday kitchen/home-care options such as warm water, ginger tea, honey-lemon water, salt-water gargle, steam inhalation, warm compress, rest, light meals, and homemade oral rehydration drink.
  - Include exactly one short dosage/frequency tag only (e.g., "1 cup/day", "2-3 times/day", "15-20 min/day").
  - Tags must NOT list ingredients such as "250 ml water", "10 g ginger", or "500 mg tablet".
  - howToUse MUST be 1–3 short plain-English sentences (NO labels like "Ingredients:"/"Steps:", NO bullets, NO numbering).
  - howToUse MUST describe the correct preparation or use for that exact remedy; do not copy a generic instruction from another remedy.
  - Include exact measured quantities using metric units (g, ml, L) directly inside the sentence flow.
  - Do not provide vague instructions like "some ginger" or "as needed".
  - Include both ingredient amount and liquid amount where applicable (e.g., "10 g ginger", "250 ml (0.25 L) water"), plus basic time guidance.
  - notes should mention key cautions (e.g., "Avoid if diabetic", "Not for infants").
- recommendedTests: exactly 3 items. Use practical, symptom-specific tests/checks for persistent, recurrent, unclear, or severe symptoms. Avoid unrelated exams/tests.
- redFlags: 2–6 items, urgent symptoms needing doctor/ER.
  - Must be specific danger signs related to the user's symptoms (not generic advice).
  - Each item should be one short, plain-English sentence.
  - Do not repeat the disclaimer in redFlags.
- emergencyAlert: either null or an object with title and message.
  - Use emergencyAlert only for true medical emergencies or very high-risk patterns such as heart attack, stroke, severe breathing trouble, anaphylaxis, severe trauma, or major bleeding.
  - The message must clearly say the condition is a medical emergency and not something that can be safely treated with natural remedies at home.
  - Even when emergencyAlert is present, still include 3-5 naturalRemedies items, but they must be supportive care only and must not delay emergency treatment. Good examples are safe positioning, rest, loosening tight clothing, or avoiding food/drink when swallowing may be unsafe.
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
  if (
    ai.emergencyAlert != null &&
    (typeof ai.emergencyAlert !== "object" ||
      typeof ai.emergencyAlert.title !== "string" ||
      typeof ai.emergencyAlert.message !== "string")
  ) {
    return false;
  }
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

  if (isInjurySymptomText(symptomText)) {
    fallback.push("Severe deformity, exposed bone, heavy bleeding, or the injured area becoming cold, blue, or numb.");
    fallback.push("Rapid swelling, severe pain after a fall or trauma, or inability to move the fingers or injured limb.");
  }
  if (/headache|migraine/.test(symptomText)) {
    fallback.push("Sudden severe headache, confusion, fainting, weakness, vision changes, or stiff neck.");
  }
  if (/fever|chills|temperature/.test(symptomText)) {
    fallback.push("Fever above 103°F (39.4°C), fever lasting more than 3 days, rash, or severe weakness.");
  }
  if (/cough|breath|chest/.test(symptomText)) {
    fallback.push("Trouble breathing, chest pain or pressure, coughing blood, or blue lips/fingertips.");
  }
  if (/stomach|abdomen|abdominal|belly|gastric|nausea|vomit|diarrhea|constipat/.test(symptomText)) {
    fallback.push("Sudden sharp or severe abdominal pain, or a belly that is rigid, hard, or very tender.");
    fallback.push("Vomiting blood, black or bloody stool, chest/neck/shoulder pain, or inability to pass stool with vomiting.");
  }

  fallback.push("Persistent vomiting, inability to keep fluids down, or signs of dehydration.");
  fallback.push("Symptoms getting rapidly worse instead of improving within 24–48 hours.");

  return normalizeStringList(fallback).slice(0, 6);
}

function normalizeRedFlags(redFlags, symptoms, language = "en") {
  const cleaned = normalizeStringList(redFlags)
    .filter((item) => !/not a diagnosis|consult (a )?healthcare professional/i.test(item))
    .slice(0, 6);

  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    const diseaseRedFlags = buildNamedDiseaseAnalysis(namedDisease)?.redFlags || [];
    return normalizeStringList([...cleaned, ...diseaseRedFlags]).slice(0, 6);
  }

  if (language !== "en" && cleaned.length >= 2) return cleaned;
  if (cleaned.length >= 2) return cleaned;

  const fallback = buildFallbackRedFlags(symptoms);
  const merged = normalizeStringList([...cleaned, ...fallback]).slice(0, 6);
  return merged.length ? merged : fallback.slice(0, 2);
}

function clampConfidence(value, maxConfidence) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.min(0.5, maxConfidence);
  return Math.max(0, Math.min(number, maxConfidence, 1));
}

function isInjurySymptomText(symptomText) {
  return /\b(broken|fracture|fractured|sprain|sprained|dislocation|dislocated|injury|injured|swelling after fall|hand injury|wrist injury|ankle injury|arm injury|leg injury|cut|wound|bruise|bruised|trauma|fell|fall injury)\b/i.test(
    symptomText,
  );
}

function isCardiacEmergencySymptomText(symptomText) {
  return /\b(heart attack|crushing chest pain|pressure in chest|chest pressure|central chest pain|pain to left arm|pain down left arm|jaw pain with chest pain|shortness of breath with chest pain)\b/i.test(
    symptomText,
  );
}

function isStrokeSymptomText(symptomText) {
  return /\b(stroke|slurred speech|one sided weakness|one-sided weakness|face drooping|facial droop|sudden weakness|sudden numbness on one side)\b/i.test(
    symptomText,
  );
}

function detectSymptomProfile(symptomText) {
  if (isCardiacEmergencySymptomText(symptomText)) return "cardiac_emergency";
  if (isStrokeSymptomText(symptomText)) return "stroke_emergency";
  if (/\b(dengue|dengue fever|retro orbital pain|eye pain with fever)\b/i.test(symptomText)) {
    return "dengue";
  }
  if (/\b(typhoid|typhoid fever|enteric fever)\b/i.test(symptomText)) {
    return "typhoid";
  }
  if (/\b(jaundice|yellow eyes|yellow eye|yellow skin|icterus)\b/i.test(symptomText)) {
    return "jaundice";
  }
  if (isInjurySymptomText(symptomText)) return "injury";
  if (/fever|temperature|chills/.test(symptomText) && /headache|migraine/.test(symptomText)) {
    return "fever_headache";
  }
  if (/stomach|abdomen|abdominal|belly|gastric|nausea|vomit|diarrhea|constipat/.test(symptomText)) {
    return "stomach";
  }
  if (/headache|migraine/.test(symptomText)) return "headache";
  if (/cough|sore throat|runny nose|cold|congestion/.test(symptomText)) return "respiratory";

  return "generic";
}

function getNamedDiseaseMatch(symptomText) {
  const text = cleanText(symptomText).toLowerCase();
  const catalog = [
    { id: "covid19", label: "COVID-19", patterns: [/\bcovid(?:-19)?\b/, /\bcoronavirus\b/] },
    { id: "influenza", label: "Influenza", patterns: [/\binfluenza\b/, /\bseasonal flu\b/, /\bflu\b/] },
    { id: "hepatitis_b", label: "Hepatitis B", patterns: [/\bhepatitis b\b/, /\bhbv\b/] },
    { id: "tuberculosis", label: "Tuberculosis", patterns: [/\btuberculosis\b/, /\b tb\b/, /\bchronic tb\b/] },
    { id: "cholera", label: "Cholera", patterns: [/\bcholera\b/] },
    { id: "malaria", label: "Malaria", patterns: [/\bmalaria\b/] },
    { id: "candidiasis", label: "Candidiasis", patterns: [/\bcandidiasis\b/, /\bcandida\b/, /\bthrush\b/, /\byeast infection\b/] },
    { id: "diabetes", label: "Diabetes", patterns: [/\bdiabetes\b/, /\bdiabetic\b/] },
    { id: "hypertension", label: "Hypertension", patterns: [/\bhypertension\b/, /\bhigh blood pressure\b/] },
    { id: "asthma", label: "Asthma", patterns: [/\basthma\b/, /\basthmatic\b/] },
    { id: "ckd", label: "Chronic Kidney Disease", patterns: [/\bchronic kidney disease\b/, /\bckd\b/, /\bkidney failure\b/] },
    { id: "cad", label: "Coronary Artery Disease", patterns: [/\bcoronary artery disease\b/, /\bcad\b/, /\bischemic heart disease\b/] },
    { id: "heart_failure", label: "Heart Failure", patterns: [/\bheart failure\b/, /\bcongestive heart failure\b/, /\bchf\b/] },
    { id: "copd", label: "Chronic Obstructive Pulmonary Disease", patterns: [/\bchronic obstructive pulmonary disease\b/, /\bcopd\b/] },
    { id: "pneumonia", label: "Pneumonia", patterns: [/\bpneumonia\b/] },
    { id: "bronchitis", label: "Bronchitis", patterns: [/\bbronchitis\b/] },
    { id: "alzheimers", label: "Alzheimer's Disease", patterns: [/\balzheimer'?s\b/, /\balzheimer disease\b/] },
    { id: "parkinsons", label: "Parkinson's Disease", patterns: [/\bparkinson'?s\b/, /\bparkinson disease\b/] },
    { id: "epilepsy", label: "Epilepsy", patterns: [/\bepilepsy\b/, /\bseizure disorder\b/] },
    { id: "depression", label: "Depression", patterns: [/\bdepression\b/, /\bmajor depressive\b/] },
    { id: "anxiety", label: "Anxiety Disorder", patterns: [/\banxiety disorder\b/, /\banxiety\b/, /\bpanic disorder\b/] },
    { id: "schizophrenia", label: "Schizophrenia", patterns: [/\bschizophrenia\b/, /\bpsychosis\b/] },
    { id: "gerd", label: "Gastroesophageal Reflux Disease", patterns: [/\bgastroesophageal reflux disease\b/, /\bgerd\b/, /\bacid reflux disease\b/] },
    { id: "ibs", label: "Irritable Bowel Syndrome", patterns: [/\birritable bowel syndrome\b/, /\bibs\b/] },
    { id: "cirrhosis", label: "Liver Cirrhosis", patterns: [/\bliver cirrhosis\b/, /\bcirrhosis\b/] },
    { id: "hypothyroidism", label: "Hypothyroidism", patterns: [/\bhypothyroidism\b/, /\bunderactive thyroid\b/] },
    { id: "hyperthyroidism", label: "Hyperthyroidism", patterns: [/\bhyperthyroidism\b/, /\boveractive thyroid\b/] },
    { id: "down_syndrome", label: "Down Syndrome", patterns: [/\bdown syndrome\b/, /\btrisomy 21\b/] },
    { id: "sickle_cell", label: "Sickle Cell Disease", patterns: [/\bsickle cell disease\b/, /\bsickle cell\b/, /\bscd\b/] },
    { id: "cystic_fibrosis", label: "Cystic Fibrosis", patterns: [/\bcystic fibrosis\b/, /\bcf\b/] },
    { id: "rheumatoid_arthritis", label: "Rheumatoid Arthritis", patterns: [/\brheumatoid arthritis\b/, /\bra\b/] },
    { id: "lupus", label: "Lupus", patterns: [/\blupus\b/, /\bsystemic lupus\b/, /\bsle\b/] },
    { id: "breast_cancer", label: "Breast Cancer", patterns: [/\bbreast cancer\b/] },
    { id: "lung_cancer", label: "Lung Cancer", patterns: [/\blung cancer\b/] },
    { id: "leukemia", label: "Leukemia", patterns: [/\bleukemia\b/] },
    { id: "eczema", label: "Eczema", patterns: [/\beczema\b/, /\batopic dermatitis\b/] },
    { id: "psoriasis", label: "Psoriasis", patterns: [/\bpsoriasis\b/] },
    { id: "acne", label: "Acne", patterns: [/\bacne\b/] },
    { id: "osteoarthritis", label: "Osteoarthritis", patterns: [/\bosteoarthritis\b/, /\boa\b/] },
    { id: "osteoporosis", label: "Osteoporosis", patterns: [/\bosteoporosis\b/] },
    { id: "pcos", label: "Polycystic Ovary Syndrome", patterns: [/\bpolycystic ovary syndrome\b/, /\bpcos\b/] },
    { id: "ed", label: "Erectile Dysfunction", patterns: [/\berectile dysfunction\b/, /\bed\b/] },
    { id: "malnutrition", label: "Malnutrition", patterns: [/\bmalnutrition\b/, /\bundernutrition\b/] },
    { id: "obesity", label: "Obesity", patterns: [/\bobesity\b/, /\bobese\b/] },
    { id: "cataract", label: "Cataract", patterns: [/\bcataract\b/] },
    { id: "glaucoma", label: "Glaucoma", patterns: [/\bglaucoma\b/] },
    { id: "hearing_loss", label: "Hearing Loss", patterns: [/\bhearing loss\b/, /\bhard of hearing\b/] },
  ];

  return (
    catalog.find((entry) => entry.patterns.some((pattern) => pattern.test(text))) || null
  );
}

function buildNamedDiseaseAnalysis(match) {
  if (!match) return null;

  switch (match.id) {
    case "covid19":
      return {
        conditions: [
          { name: "COVID-19", confidence: 0.84, rationale: "COVID-19 often causes fever, cough, sore throat, body aches, or fatigue. Shortness of breath or low oxygen makes it more urgent." },
          { name: "Viral upper respiratory infection", confidence: 0.68, rationale: "Other viral infections can look similar early on. Testing helps separate COVID-19 from other viral illness." },
          { name: "COVID-related bronchitis", confidence: 0.62, rationale: "COVID-19 can irritate the airways and trigger cough or chest discomfort. Wheezing or tightness can happen in some adults." },
          { name: "COVID-related dehydration", confidence: 0.56, rationale: "Fever and poor intake can lower fluid levels during COVID-19. Weakness, dizziness, or dark urine make dehydration more likely." },
          { name: "COVID-related pneumonia", confidence: 0.54, rationale: "COVID-19 can involve the lungs and reduce oxygen exchange. Fast breathing, chest pain, or worsening cough raise concern." },
        ],
        tests: [
          { name: "COVID-19 rapid antigen or PCR test", reason: "The most direct test to confirm current COVID-19 infection." },
          { name: "Temperature and oxygen saturation check", reason: "Useful to detect fever and low oxygen if the lungs are involved." },
          { name: "Chest examination", reason: "A clinician can listen for lung involvement and decide if chest imaging is needed." },
        ],
        remedies: [
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink 150-250 ml warm water slowly through the day to support hydration. Take small sips if the throat feels sore.", notes: "Seek care for breathing trouble, blue lips, chest pain, or confusion." },
          { name: "Light Soup or Broth", tags: ["1-2 bowls/day"], howToUse: "Take 200-250 ml warm soup or broth in small sips, 1-2 times daily. Keep it light and easy to digest.", notes: "Supportive only and not a substitute for clinical care if symptoms worsen." },
          { name: "Rest in a Well-Ventilated Room", tags: ["rest periods/day"], howToUse: "Rest and reduce activity while fever, cough, or body aches continue. Keep the room airy and avoid close contact with others.", notes: "Isolate as advised locally if infection is suspected." },
        ],
        redFlags: [
          "Trouble breathing, chest pain, blue lips, or oxygen levels falling.",
          "Severe weakness, confusion, or inability to drink fluids.",
          "Symptoms getting rapidly worse instead of improving over a few days.",
        ],
      };
    case "influenza":
      return {
        conditions: [
          { name: "Influenza", confidence: 0.84, rationale: "Influenza commonly causes fever, body aches, headache, cough, and marked fatigue. It often starts suddenly and can make people feel very unwell." },
          { name: "Viral fever", confidence: 0.68, rationale: "Other viral infections can look similar in the early stage. Fever pattern and testing help tell them apart." },
          { name: "Influenza-related dehydration", confidence: 0.58, rationale: "Fever and poor appetite during flu can reduce fluid intake. Weakness or dark urine make this more likely." },
          { name: "Influenza-related bronchitis", confidence: 0.56, rationale: "The flu can inflame the airways and worsen cough or chest discomfort. Symptoms may linger even after fever improves." },
          { name: "Influenza-related pneumonia", confidence: 0.52, rationale: "The lungs can become involved in more severe flu. Shortness of breath, chest pain, or low oxygen are warning signs." },
        ],
        tests: [
          { name: "Influenza rapid test or PCR", reason: "Helps confirm influenza when fever and body aches fit the pattern." },
          { name: "Temperature and oxygen saturation check", reason: "Useful to track fever severity and detect lung involvement." },
          { name: "Chest examination", reason: "Needed if cough, chest discomfort, or breathing symptoms are significant." },
        ],
        remedies: [
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink 150-250 ml warm water slowly several times through the day. Small frequent sips may feel easier during fever.", notes: "Seek care for confusion, breathing difficulty, or persistent vomiting." },
          { name: "Light Soup or Broth", tags: ["1-2 bowls/day"], howToUse: "Take 200-250 ml warm soup or broth in small sips, 1-2 times daily. Keep it light if appetite is poor.", notes: "Helpful for comfort and hydration but not a replacement for medical treatment if flu is severe." },
          { name: "Rest in a Cool Room", tags: ["rest periods/day"], howToUse: "Rest and avoid heavy activity until fever and body aches improve. Wear light clothing and keep the room comfortably cool.", notes: "Get medical help if symptoms become severe or breathing worsens." },
        ],
        redFlags: [
          "Trouble breathing, chest pain, or lips looking blue.",
          "Confusion, fainting, or fever that stays high for several days.",
          "Dehydration signs such as very dark urine or not keeping fluids down.",
        ],
      };
    case "hepatitis_b":
      return {
        conditions: [
          { name: "Hepatitis B", confidence: 0.82, rationale: "Hepatitis B is a viral infection that can inflame the liver. Jaundice, dark urine, nausea, fatigue, or right-sided abdominal pain can occur." },
          { name: "Liver inflammation", confidence: 0.7, rationale: "Inflammation of the liver can cause tiredness, poor appetite, yellow eyes, or belly discomfort. Blood tests are needed to measure the degree of liver injury." },
          { name: "Jaundice from liver disease", confidence: 0.64, rationale: "If bilirubin rises, the eyes and skin may turn yellow. This often means the liver or bile flow needs urgent assessment." },
          { name: "Digestive upset from liver illness", confidence: 0.56, rationale: "Nausea, poor appetite, and abdominal discomfort are common during liver inflammation. These symptoms can worsen if dehydration develops." },
          { name: "Fatigue related to hepatitis", confidence: 0.52, rationale: "Viral liver disease often causes marked weakness and poor stamina. Rest and medical follow-up are important." },
        ],
        tests: [
          { name: "Hepatitis B blood panel", reason: "The main test to confirm hepatitis B infection and stage." },
          { name: "Liver function tests and bilirubin", reason: "Measures liver injury and jaundice severity." },
          { name: "Abdominal ultrasound", reason: "Can help assess liver structure or bile-flow problems when needed." },
        ],
        remedies: [
          { name: "Water and Light Fluids", tags: ["2-3 times/day"], howToUse: "Drink water and clear fluids in small amounts through the day to stay hydrated. Avoid alcohol completely.", notes: "Supportive only and does not treat hepatitis B itself." },
          { name: "Light Low-Fat Meals", tags: ["small portions/day"], howToUse: "Eat small, gentle meals such as rice, soup, toast, or other low-fat foods if tolerated. Avoid greasy meals if nausea is present.", notes: "Seek care for vomiting, confusion, or worsening jaundice." },
          { name: "Rest", tags: ["rest periods/day"], howToUse: "Rest and reduce heavy physical activity while the body is recovering. Increase activity only as strength returns.", notes: "Medical monitoring is important because liver disease can worsen." },
        ],
        redFlags: [
          "Severe yellowing of the eyes or skin, confusion, or unusual sleepiness.",
          "Repeated vomiting, severe abdominal pain, or blood in vomit or stool.",
          "Dark urine with worsening weakness or swelling in the belly or legs.",
        ],
      };
    case "tuberculosis":
      return {
        conditions: [
          { name: "Tuberculosis", confidence: 0.82, rationale: "Tuberculosis often causes chronic cough, fever, night sweats, weight loss, or weakness. It needs proper testing because it is an infectious disease." },
          { name: "Chronic lung infection", confidence: 0.7, rationale: "Long cough with fever or weight loss can also happen with other persistent lung infections. Chest testing helps separate these causes." },
          { name: "Tuberculosis-related weight loss", confidence: 0.6, rationale: "Poor appetite and long illness can lead to weight loss and weakness in TB. Nutritional support helps but does not replace treatment." },
          { name: "Anemia or fatigue from chronic infection", confidence: 0.56, rationale: "Long-term infection can lower energy and cause persistent tiredness. Blood tests can help check this." },
          { name: "Lung inflammation", confidence: 0.52, rationale: "Inflamed lung tissue can cause cough, chest discomfort, or breathing symptoms. Imaging is usually needed." },
        ],
        tests: [
          { name: "Sputum test for tuberculosis", reason: "A key test to look for TB bacteria in cough mucus." },
          { name: "Chest X-ray", reason: "Helpful to look for lung changes that fit tuberculosis." },
          { name: "Tuberculosis skin test or IGRA blood test", reason: "Used to support TB evaluation depending on the situation." },
        ],
        remedies: [
          { name: "Light Nutritious Meals", tags: ["small portions/day"], howToUse: "Take small meals with soft rice, eggs, soup, beans, or other gentle nourishing foods if tolerated. Eat regularly even if appetite is low.", notes: "Supportive only and not a substitute for TB treatment." },
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink 150-250 ml warm water several times during the day. Small sips may help if cough makes the throat dry.", notes: "Seek care quickly if coughing blood or struggling to breathe." },
          { name: "Rest", tags: ["rest periods/day"], howToUse: "Rest and limit heavy activity while the infection is being evaluated and treated. Keep the room well ventilated.", notes: "TB needs medical treatment and infection control." },
        ],
        redFlags: [
          "Coughing blood, severe shortness of breath, or chest pain.",
          "Rapid weight loss, high fever, or severe weakness.",
          "Confusion, fainting, or worsening breathing difficulty.",
        ],
      };
    case "cholera":
      return {
        conditions: [
          { name: "Cholera", confidence: 0.84, rationale: "Cholera causes sudden severe watery diarrhea and can lead to rapid dehydration. It becomes dangerous quickly if fluids are not replaced." },
          { name: "Severe dehydration", confidence: 0.76, rationale: "Large fluid losses can cause thirst, weakness, dizziness, and very low urination. Severe dehydration can become life-threatening." },
          { name: "Acute infectious diarrhea", confidence: 0.66, rationale: "Other intestinal infections can also cause heavy diarrhea. Stool testing helps identify the cause." },
          { name: "Electrolyte imbalance", confidence: 0.58, rationale: "Large diarrhea losses can disturb salts in the body. This may cause cramps, weakness, or collapse." },
          { name: "Shock from fluid loss", confidence: 0.52, rationale: "If dehydration is severe, blood pressure may fall dangerously low. Immediate medical treatment is then needed." },
        ],
        tests: [
          { name: "Stool test or stool culture", reason: "The main test to look for cholera bacteria." },
          { name: "Hydration and vital signs check", reason: "Important to assess dehydration severity and circulation." },
          { name: "Electrolyte blood test", reason: "Useful when severe diarrhea may have caused salt imbalance." },
        ],
        remedies: [
          { name: "Homemade Rehydration Drink", tags: ["2-3 times/day"], howToUse: "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip often and replace fluids after each loose stool.", notes: "Seek urgent care immediately if diarrhea is severe or weakness develops." },
          { name: "Clean Water", tags: ["2-3 times/day"], howToUse: "Drink safe boiled or treated water in small repeated amounts through the day. Continue even if appetite is poor.", notes: "Do not rely on home care alone if symptoms are severe." },
          { name: "Light Rice Porridge", tags: ["small portions/day"], howToUse: "Eat a small portion of plain rice or porridge if you can tolerate food. Keep meals simple and low in oil.", notes: "Stop if vomiting worsens and seek medical care promptly." },
        ],
        redFlags: [
          "Very frequent watery diarrhea, extreme thirst, or barely passing urine.",
          "Confusion, collapse, or weakness that makes it hard to stand.",
          "Vomiting that prevents you from keeping fluids down.",
        ],
      };
    case "malaria":
      return {
        conditions: [
          { name: "Malaria", confidence: 0.84, rationale: "Malaria commonly causes fever, chills, sweats, headache, body aches, and weakness. It needs blood testing because prompt treatment matters." },
          { name: "Mosquito-borne febrile illness", confidence: 0.68, rationale: "Other mosquito-borne infections can look similar at first. Travel area and testing help clarify the cause." },
          { name: "Malaria-related dehydration", confidence: 0.58, rationale: "Fever, sweating, and poor intake can lower fluid levels during malaria. Dizziness or dark urine make dehydration more likely." },
          { name: "Anemia from malaria", confidence: 0.56, rationale: "Malaria can break down red blood cells and lead to weakness or pallor. Blood tests are important when symptoms are significant." },
          { name: "Systemic infection with chills and fever", confidence: 0.52, rationale: "Repeated fever and chills may reflect a serious blood-borne infection. Medical evaluation is important." },
        ],
        tests: [
          { name: "Malaria rapid diagnostic test", reason: "A direct test to quickly screen for malaria infection." },
          { name: "Malaria blood smear", reason: "Helps confirm malaria and assess parasite level." },
          { name: "Complete Blood Count (CBC)", reason: "Useful to check anemia and infection impact." },
        ],
        remedies: [
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink 150-250 ml warm water or safe fluids in small repeated amounts through the day. Replace fluid losses from fever and sweating.", notes: "Malaria needs medical treatment and testing, not home remedies alone." },
          { name: "Light Soup or Broth", tags: ["1-2 bowls/day"], howToUse: "Take 200-250 ml light soup or broth in small sips, 1-2 times daily, if appetite is poor. Keep meals easy to digest.", notes: "Seek urgent care for confusion, repeated vomiting, or severe weakness." },
          { name: "Rest", tags: ["rest periods/day"], howToUse: "Rest and avoid heavy activity while fever, chills, or weakness continue. Stay protected from mosquito bites while unwell.", notes: "Supportive only while arranging medical care." },
        ],
        redFlags: [
          "Confusion, fainting, seizures, or severe weakness.",
          "Repeated vomiting, dark urine, or not being able to drink.",
          "Breathing trouble or symptoms getting worse rapidly.",
        ],
      };
    case "candidiasis":
      return {
        conditions: [
          { name: "Candidiasis", confidence: 0.8, rationale: "Candidiasis is a fungal overgrowth that may affect the mouth, skin folds, or genital area. It often causes itching, white patches, soreness, or discharge depending on the site." },
          { name: "Fungal skin or mucosal irritation", confidence: 0.68, rationale: "Yeast-related irritation can cause redness, moisture, itching, and discomfort. Warm moist areas make this more likely." },
          { name: "Skin barrier irritation", confidence: 0.58, rationale: "Friction and moisture can worsen rash and soreness around the affected area. Keeping the area clean and dry can help comfort." },
          { name: "Secondary bacterial irritation", confidence: 0.5, rationale: "Scratching or broken skin can allow secondary irritation or infection. Worsening pain, swelling, or pus needs medical review." },
          { name: "Recurrent yeast overgrowth", confidence: 0.48, rationale: "Repeated candidiasis may happen with diabetes, antibiotics, or weak skin barriers. Medical review is helpful if it keeps coming back." },
        ],
        tests: [
          { name: "Physical examination of the affected area", reason: "A clinician can often identify candidiasis by appearance and location." },
          { name: "Swab or scraping if needed", reason: "Useful when the diagnosis is uncertain or symptoms are persistent." },
          { name: "Blood sugar check", reason: "Repeated yeast infections can be more common when diabetes is poorly controlled." },
        ],
        remedies: [
          { name: "Keep the Area Dry", tags: ["2-3 times/day"], howToUse: "Gently wash with clean water and pat the area dry without rubbing. Change damp clothing or underwear promptly.", notes: "Avoid harsh soaps or tight clothing that worsens irritation." },
          { name: "Plain Unscented Skin Care", tags: ["1-2 times/day"], howToUse: "Use a gentle unscented cleanser if cleansing is needed. Avoid fragranced products on irritated skin or mucosal areas.", notes: "Supportive only and does not replace antifungal treatment when needed." },
          { name: "Loose Cotton Clothing", tags: ["through the day"], howToUse: "Wear breathable loose clothing to reduce moisture and friction in the affected area. Change sweaty clothes quickly.", notes: "Seek care if the rash spreads, becomes very painful, or repeatedly returns." },
        ],
        redFlags: [
          "Severe pain, pus, swelling, or rapidly spreading redness.",
          "Trouble swallowing, dehydration, or extensive mouth sores.",
          "Repeated infections, fever, or symptoms not improving with basic care.",
        ],
      };
    case "diabetes":
      return {
        conditions: [
          { name: "Diabetes mellitus", confidence: 0.84, rationale: "Diabetes affects how the body handles blood sugar over time. Thirst, frequent urination, fatigue, blurred vision, or slow healing are common concerns." },
          { name: "Poor blood sugar control", confidence: 0.72, rationale: "Symptoms can worsen when glucose stays too high or drops too low. Monitoring and medical review are important." },
          { name: "Diabetes-related dehydration", confidence: 0.58, rationale: "High blood sugar can lead to fluid loss and increased thirst. Weakness and dark urine may develop if intake is poor." },
          { name: "Diabetes-related nerve or foot risk", confidence: 0.54, rationale: "Long-term diabetes can affect sensation and wound healing. Numbness or foot sores need early attention." },
          { name: "Diabetes-related infection risk", confidence: 0.52, rationale: "Repeated skin, urine, or yeast infections can occur when diabetes is not well controlled. Persistent infection symptoms need assessment." },
        ],
        tests: [
          { name: "Blood glucose check", reason: "The quickest test to see if sugar is currently high or low." },
          { name: "HbA1c test", reason: "Shows average blood sugar control over the last 2 to 3 months." },
          { name: "Urine or kidney screening", reason: "Helpful to check for diabetes-related kidney impact when appropriate." },
        ],
        remedies: [
          { name: "Regular Balanced Meals", tags: ["small portions/day"], howToUse: "Eat meals at regular times with simple balanced portions instead of skipping meals. Prefer vegetables, beans, whole grains, and moderate portions if tolerated.", notes: "Home care does not replace diabetes monitoring or prescribed treatment." },
          { name: "Water in Moderate Amounts", tags: ["2-3 times/day"], howToUse: "Drink plain water in steady small amounts through the day unless a clinician has told you to limit fluids. This helps if thirst is increased.", notes: "Seek urgent care for confusion, vomiting, very high sugar, or severe weakness." },
          { name: "Daily Foot Check", tags: ["1 time/day"], howToUse: "Check both feet daily for blisters, cuts, redness, or swelling, especially if sensation is reduced. Keep feet clean and dry.", notes: "Get medical care early for foot wounds or infection signs." },
        ],
        redFlags: [
          "Confusion, repeated vomiting, deep breathing, or severe weakness.",
          "Foot ulcers, spreading redness, or signs of serious infection.",
          "Very high or very low blood sugar symptoms with fainting or drowsiness.",
        ],
      };
    case "hypertension":
      return {
        conditions: [
          { name: "Hypertension", confidence: 0.82, rationale: "Hypertension means blood pressure stays high over time and often causes no early symptoms. It still raises the risk of stroke, heart disease, and kidney damage." },
          { name: "Poor blood pressure control", confidence: 0.68, rationale: "Readings that stay above target suggest blood pressure is not well controlled. Headache or dizziness may happen, but many people feel normal." },
          { name: "Hypertensive strain on the heart", confidence: 0.56, rationale: "Long-term high blood pressure can overload the heart and blood vessels. This increases the risk of chest symptoms or heart failure over time." },
          { name: "Hypertensive kidney strain", confidence: 0.54, rationale: "High blood pressure can slowly damage the kidneys. Swelling, abnormal urine tests, or CKD may develop later." },
          { name: "Vascular risk state", confidence: 0.52, rationale: "Persistent hypertension raises the risk of stroke and heart attack even without symptoms. Regular monitoring is important." },
        ],
        tests: [
          { name: "Repeated blood pressure measurement", reason: "Needed to confirm hypertension and see if it is controlled." },
          { name: "Kidney function and urine test", reason: "Helpful because hypertension can affect the kidneys over time." },
          { name: "Heart examination or ECG if needed", reason: "Useful when long-standing high blood pressure may be affecting the heart." },
        ],
        remedies: [
          { name: "Lower-Salt Meals", tags: ["small portions/day"], howToUse: "Choose lighter meals with less added salt and fewer salty packaged foods. Use herbs or lemon instead of extra salt when possible.", notes: "Supportive only and does not replace blood pressure treatment." },
          { name: "Calm Rest Periods", tags: ["rest periods/day"], howToUse: "Sit quietly and rest for several minutes if you feel stressed or your reading is high. Repeat blood pressure after resting if you monitor at home.", notes: "Seek urgent care for chest pain, stroke symptoms, or severe headache with neurologic changes." },
          { name: "Gentle Daily Walking", tags: ["1 time/day"], howToUse: "If you are stable and a clinician has not restricted activity, do a short gentle walk most days. Stop if chest pain, dizziness, or breathlessness appears.", notes: "Avoid strenuous exercise during acute symptoms." },
        ],
        redFlags: [
          "Chest pain, sudden shortness of breath, or fainting.",
          "Severe headache with weakness, slurred speech, or vision changes.",
          "Very high readings with confusion or worsening neurologic symptoms.",
        ],
      };
    case "asthma":
      return {
        conditions: [
          { name: "Asthma", confidence: 0.84, rationale: "Asthma causes airway narrowing and inflammation that can lead to wheeze, cough, or chest tightness. Symptoms often worsen with triggers like dust, smoke, cold air, or infection." },
          { name: "Asthma flare", confidence: 0.74, rationale: "A flare may cause more cough, wheeze, or breathlessness than usual. Night symptoms or trouble speaking suggest the attack may be more serious." },
          { name: "Airway irritation", confidence: 0.58, rationale: "Smoke, perfume, dust, or a viral infection can irritate sensitive airways. This can trigger cough or tightness in asthma." },
          { name: "Respiratory infection worsening asthma", confidence: 0.56, rationale: "Colds and other infections often trigger asthma symptoms. Fever or thicker mucus may suggest infection is contributing." },
          { name: "Exercise- or allergy-triggered symptoms", confidence: 0.5, rationale: "Activity or environmental triggers can bring on coughing and wheeze in susceptible people. Knowing triggers helps with control." },
        ],
        tests: [
          { name: "Peak flow or spirometry", reason: "Measures how much the airways are narrowing." },
          { name: "Oxygen saturation check", reason: "Important if breathing is difficult or a flare is severe." },
          { name: "Chest examination", reason: "A clinician can listen for wheeze and assess severity." },
        ],
        remedies: [
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink warm water in small sips if cough makes the throat dry. Stop if swallowing is difficult or coughing worsens.", notes: "Supportive only and not a replacement for an inhaler or urgent care." },
          { name: "Avoid Smoke and Dust", tags: ["through the day"], howToUse: "Move away from smoke, strong perfume, dust, or cold air if these make breathing worse. Stay in clean air while symptoms settle.", notes: "Seek urgent care for severe breathlessness, blue lips, or trouble speaking." },
          { name: "Supported Sitting Position", tags: ["rest periods/day"], howToUse: "Sit upright with the back supported and shoulders relaxed if breathing feels tight. Avoid lying flat if it makes breathing harder.", notes: "Use prescribed emergency asthma treatment if available and seek help if severe." },
        ],
        redFlags: [
          "Severe shortness of breath, blue lips, or trouble speaking in full sentences.",
          "No improvement with usual rescue treatment or symptoms worsening quickly.",
          "Drowsiness, confusion, or silent chest with very little air movement.",
        ],
      };
    case "ckd":
      return {
        conditions: [
          { name: "Chronic Kidney Disease", confidence: 0.82, rationale: "Chronic kidney disease means the kidneys are not filtering as well over time. Fatigue, swelling, abnormal urine, or worsening blood pressure can happen." },
          { name: "Fluid or salt imbalance", confidence: 0.64, rationale: "Kidney disease can affect fluid and salt balance in the body. Swelling or shortness of breath may appear if this worsens." },
          { name: "Anemia related to kidney disease", confidence: 0.58, rationale: "CKD can contribute to low red blood cell levels and chronic tiredness. Blood tests help evaluate this." },
          { name: "High blood pressure linked to kidney disease", confidence: 0.56, rationale: "Kidney disease and hypertension often worsen each other. Monitoring both is important." },
          { name: "Progressive kidney function decline", confidence: 0.52, rationale: "CKD may gradually worsen if underlying causes are not controlled. Regular testing is needed." },
        ],
        tests: [
          { name: "Serum creatinine and eGFR", reason: "The key blood test to estimate kidney function." },
          { name: "Urine protein or urine albumin test", reason: "Useful to check how much kidney damage is present." },
          { name: "Electrolytes and blood pressure check", reason: "Important because CKD can disturb salt balance and raise blood pressure." },
        ],
        remedies: [
          { name: "Lower-Salt Meals", tags: ["small portions/day"], howToUse: "Choose meals with less salt and fewer processed foods if a clinician has not told you otherwise. Keep portions moderate and simple.", notes: "Fluid and diet plans in CKD should follow medical advice." },
          { name: "Rest", tags: ["rest periods/day"], howToUse: "Rest between activities if fatigue is significant. Spread tasks across the day instead of doing everything at once.", notes: "Seek care for reduced urine, worsening swelling, or shortness of breath." },
          { name: "Medication and Appointment Adherence", tags: ["1 time/day"], howToUse: "Follow prescribed kidney, blood pressure, or diabetes care closely and keep follow-up visits. Track swelling, urine changes, and blood pressure if advised.", notes: "Supportive habit only; CKD needs ongoing medical care." },
        ],
        redFlags: [
          "Very little urine, worsening swelling, or shortness of breath.",
          "Confusion, severe weakness, or persistent vomiting.",
          "Chest pain or very high blood pressure with neurologic symptoms.",
        ],
      };
    case "cad":
      return {
        conditions: [
          { name: "Coronary Artery Disease", confidence: 0.8, rationale: "Coronary artery disease reduces blood flow to the heart over time. It can cause exertional chest discomfort, breathlessness, or reduced exercise tolerance." },
          { name: "Stable angina", confidence: 0.68, rationale: "Stable angina often causes chest pressure with activity or stress that improves with rest. New or worsening pain needs urgent assessment." },
          { name: "Reduced cardiac blood flow", confidence: 0.62, rationale: "Blocked heart arteries can limit oxygen to the heart muscle. This may show up as fatigue, chest pressure, or shortness of breath." },
          { name: "Cardiovascular risk progression", confidence: 0.54, rationale: "Coronary disease can worsen silently over time. Monitoring risk factors and symptoms is important." },
          { name: "Heart strain with exertion", confidence: 0.5, rationale: "When the heart works harder during activity, symptoms may appear if blood flow is limited. This needs proper medical follow-up." },
        ],
        tests: [
          { name: "ECG (electrocardiogram)", reason: "A basic test to look for rhythm or blood-flow changes affecting the heart." },
          { name: "Stress test or cardiology evaluation", reason: "Helps assess how symptoms change with exertion." },
          { name: "Lipid profile and blood pressure check", reason: "Important because cholesterol and pressure strongly affect CAD risk." },
        ],
        remedies: [
          { name: "Lower-Salt Light Meals", tags: ["small portions/day"], howToUse: "Use lighter meals with less salt and heavy oil to avoid extra strain after eating. Keep portions moderate and regular.", notes: "Supportive only and not a treatment for blocked heart arteries." },
          { name: "Rest During Symptoms", tags: ["rest periods/day"], howToUse: "Stop activity and sit quietly if chest discomfort or breathlessness appears with exertion. Restart only after symptoms fully settle and a clinician has advised activity is safe.", notes: "Seek urgent care if chest pain is severe, prolonged, or occurs at rest." },
          { name: "Gentle Daily Walking if Stable", tags: ["1 time/day"], howToUse: "If a clinician has not restricted exercise, use short gentle walks instead of sudden strenuous effort. Stop immediately if chest symptoms appear.", notes: "Do not push through chest pain or marked breathlessness." },
        ],
        redFlags: [
          "Chest pain at rest, pain spreading to the arm or jaw, or severe shortness of breath.",
          "Sweating, fainting, or symptoms lasting more than a few minutes.",
          "New or rapidly worsening chest symptoms compared with usual pattern.",
        ],
      };
    case "heart_failure":
      return {
        conditions: [
          { name: "Heart Failure", confidence: 0.82, rationale: "Heart failure means the heart is not pumping blood as effectively as it should. Shortness of breath, swelling, fatigue, or trouble lying flat are common concerns." },
          { name: "Fluid overload", confidence: 0.72, rationale: "Fluid can build up in the lungs or legs when heart failure worsens. Rapid weight gain or swelling makes this more likely." },
          { name: "Reduced exercise tolerance", confidence: 0.6, rationale: "Even mild activity may cause early breathlessness or fatigue in heart failure. This can worsen over time if the condition is not controlled." },
          { name: "Heart-related shortness of breath", confidence: 0.56, rationale: "Breathlessness can be worse when lying down or at night if the heart is overloaded. This needs prompt review if it worsens." },
          { name: "Salt and fluid-related symptom worsening", confidence: 0.5, rationale: "Extra salt and fluid can worsen swelling and breathing symptoms in heart failure. Daily monitoring is important." },
        ],
        tests: [
          { name: "Physical exam and oxygen saturation check", reason: "Useful to assess breathing, swelling, and circulation." },
          { name: "Echocardiogram", reason: "One of the main tests used to evaluate heart pumping function." },
          { name: "Kidney function and electrolytes", reason: "Important because heart failure treatment and fluid balance affect the kidneys and salts." },
        ],
        remedies: [
          { name: "Lower-Salt Meals", tags: ["small portions/day"], howToUse: "Choose meals with less added salt and avoid salty packaged foods if a clinician has advised this. Keep portions moderate to avoid feeling too full.", notes: "Follow your own heart-failure plan if one has already been prescribed." },
          { name: "Rest with Head Raised", tags: ["rest periods/day"], howToUse: "Rest with the head and shoulders slightly raised if lying flat makes breathing harder. Take activity breaks through the day.", notes: "Seek urgent care for marked breathlessness, blue lips, or chest pain." },
          { name: "Daily Symptom Tracking", tags: ["1 time/day"], howToUse: "Track swelling, breathing, and daily weight if your clinician has advised it. Report sudden worsening promptly.", notes: "Supportive habit only and not a substitute for medical treatment." },
        ],
        redFlags: [
          "Shortness of breath at rest, blue lips, or waking up gasping for air.",
          "Rapid leg or belly swelling or sudden weight gain over a short time.",
          "Chest pain, fainting, or confusion.",
        ],
      };
    case "copd":
    case "pneumonia":
    case "bronchitis": {
      const primary = match.label;
      const isPneumonia = match.id === "pneumonia";
      const isCopd = match.id === "copd";
      return {
        conditions: [
          { name: primary, confidence: 0.82, rationale: `${primary} affects the lungs and can cause cough, sputum, chest discomfort, or breathlessness. Fever is more suggestive of infection such as pneumonia or bronchitis.` },
          { name: isCopd ? "COPD flare" : "Lower airway inflammation", confidence: 0.68, rationale: "The lower airways can become inflamed and narrow, making breathing feel harder. Wheeze, mucus, or tightness can increase during flares." },
          { name: isPneumonia ? "Lung infection" : "Respiratory infection", confidence: 0.62, rationale: "A chest infection can increase cough, weakness, and breathing symptoms. Fever or thicker mucus makes infection more likely." },
          { name: "Reduced oxygen exchange", confidence: 0.56, rationale: "When lung involvement is stronger, oxygen may not move as well into the body. Fast breathing or blue lips are warning signs." },
          { name: "Fatigue from breathing effort", confidence: 0.5, rationale: "Working harder to breathe can cause tiredness and reduced stamina. Symptoms need review if they are worsening." },
        ],
        tests: [
          { name: "Oxygen saturation check", reason: "Important to see if the lungs are maintaining oxygen properly." },
          { name: isCopd ? "Spirometry or lung function testing" : "Chest examination", reason: isCopd ? "Useful to assess airflow limitation in COPD." : "A clinician can assess how severe the chest involvement is." },
          { name: isPneumonia ? "Chest X-ray" : "Temperature and respiratory evaluation", reason: isPneumonia ? "Often used when pneumonia is suspected." : "Helps judge infection severity and need for further testing." },
        ],
        remedies: [
          { name: "Warm Water", tags: ["2-3 times/day"], howToUse: "Drink warm water in small sips through the day if cough dries the throat. Take fluids steadily rather than all at once.", notes: "Supportive only and not a substitute for lung treatment." },
          { name: "Avoid Smoke and Dust", tags: ["through the day"], howToUse: "Stay away from smoke, fumes, dust, or cold air that worsen cough or breathlessness. Keep the room aired but not cold.", notes: "Seek urgent care for worsening breathing, chest pain, or blue lips." },
          { name: "Supported Sitting Position", tags: ["rest periods/day"], howToUse: "Sit upright with the back supported if breathing feels heavy. Rest between activities and avoid forcing exertion.", notes: "Go for urgent medical care if breathing difficulty is severe." },
        ],
        redFlags: [
          "Trouble breathing at rest, blue lips, or confusion.",
          "Chest pain, coughing blood, or very low oxygen.",
          isPneumonia ? "High fever with worsening weakness or rapid breathing." : "Symptoms worsening rapidly instead of improving.",
        ],
      };
    }
    case "alzheimers":
    case "parkinsons":
    case "epilepsy": {
      const primary = match.label;
      const isEpilepsy = match.id === "epilepsy";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} affects the brain or nervous system and often needs long-term specialist care. Symptoms may include memory, movement, or seizure-related problems depending on the condition.` },
          { name: isEpilepsy ? "Seizure disorder" : "Chronic neurologic condition", confidence: 0.66, rationale: "Neurologic illnesses often require structured treatment and monitoring. Sudden worsening needs prompt review." },
          { name: isEpilepsy ? "Post-seizure confusion or fatigue" : "Functional decline risk", confidence: 0.56, rationale: "The condition can affect safety, daily activities, and energy. Family support and early review matter when symptoms change." },
          { name: match.id === "parkinsons" ? "Balance and swallowing risk" : "Cognitive or safety risk", confidence: 0.52, rationale: "Falls, confusion, or swallowing problems can complicate neurologic disease. These need attention if they appear." },
          { name: "Long-term care support need", confidence: 0.48, rationale: "Regular monitoring helps with symptom control and safety planning. Home measures are supportive only." },
        ],
        tests: [
          { name: "Neurologic examination", reason: "A clinician can assess memory, movement, coordination, or seizure history." },
          { name: isEpilepsy ? "EEG (brain wave test)" : "Brain imaging or specialist review if indicated", reason: isEpilepsy ? "Useful to support seizure evaluation." : "Sometimes needed depending on symptoms and disease stage." },
          { name: "Medication and functional review", reason: "Important to check whether daily activities and treatment plans are still appropriate." },
        ],
        remedies: [
          { name: "Regular Meals and Hydration", tags: ["small portions/day"], howToUse: "Keep meals and fluids regular through the day to support strength and routine. Use simple foods if appetite is poor.", notes: "Supportive only and not a treatment for neurologic disease." },
          { name: "Safe Calm Environment", tags: ["through the day"], howToUse: "Reduce clutter, rushing, and obvious fall hazards in the home. Keep lighting good and pathways clear.", notes: "Seek urgent care for sudden confusion, repeated falls, or seizures." },
          { name: "Consistent Sleep Routine", tags: ["1 time/day"], howToUse: "Keep a steady sleep-wake routine and avoid overstimulation late at night. Rest can help reduce fatigue or confusion.", notes: "Worsening symptoms still need medical review." },
        ],
        redFlags: [
          isEpilepsy ? "Seizure lasting more than 5 minutes or repeated seizures without recovery." : "Sudden severe confusion, collapse, or new one-sided weakness.",
          "Repeated falls, choking, or unsafe wandering.",
          "Breathing trouble, head injury, or prolonged unresponsiveness.",
        ],
      };
    }
    case "depression":
    case "anxiety":
    case "schizophrenia": {
      const primary = match.label;
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} affects mood, thoughts, or behavior and often needs structured mental health care. Symptoms may also disturb sleep, appetite, concentration, or daily functioning.` },
          { name: "Stress-related physical symptoms", confidence: 0.62, rationale: "Mental health symptoms can also cause body tension, poor sleep, headaches, or stomach upset. Persistent distress still needs proper evaluation." },
          { name: "Functional impact on daily life", confidence: 0.58, rationale: "Work, study, self-care, and relationships can all be affected when symptoms worsen. Early support can reduce this impact." },
          { name: "Sleep and appetite disturbance", confidence: 0.54, rationale: "Mood or anxiety problems often disrupt sleep and eating patterns. These changes can further worsen energy and concentration." },
          { name: "Safety and relapse risk", confidence: 0.5, rationale: "Severe or recurring symptoms can lead to crisis situations without timely care. Monitoring warning signs is important." },
        ],
        tests: [
          { name: "Mental health clinical assessment", reason: "The main step to assess symptom severity, safety, and diagnosis." },
          { name: "Sleep, substance, and medication review", reason: "Helpful because sleep disruption or substances can worsen mental health symptoms." },
          { name: "Basic physical examination if needed", reason: "Used to rule out physical causes that may mimic or worsen mental symptoms." },
        ],
        remedies: [
          { name: "Regular Meals and Water", tags: ["small portions/day"], howToUse: "Take small regular meals and fluids through the day even if appetite is low. Stable eating patterns can help energy and concentration.", notes: "Supportive only and not a replacement for mental health treatment." },
          { name: "Consistent Sleep Routine", tags: ["1 time/day"], howToUse: "Try to sleep and wake at consistent times and reduce screens late at night. A steady routine can reduce stress and exhaustion.", notes: "Seek urgent help for suicidal thoughts, violence risk, or severe confusion." },
          { name: "Quiet Breathing or Grounding Break", tags: ["2-3 times/day"], howToUse: "Take a few quiet minutes for slow breathing or grounding when symptoms rise. Sit in a safe place and focus on slow steady breaths.", notes: "This is only a support skill and not enough for severe symptoms or crisis." },
        ],
        redFlags: [
          "Thoughts of self-harm, suicide, or harming others.",
          "Severe confusion, hearing threatening voices, or loss of touch with reality.",
          "Not eating or drinking, extreme agitation, or inability to stay safe.",
        ],
      };
    }
    case "gerd":
    case "ibs":
    case "cirrhosis": {
      const primary = match.label;
      const isCirrhosis = match.id === "cirrhosis";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} affects the digestive system and can cause ongoing symptoms such as pain, bloating, reflux, or fatigue. Medical review is important when symptoms are persistent or worsening.` },
          { name: isCirrhosis ? "Liver-related fluid or toxin buildup" : "Digestive irritation", confidence: 0.66, rationale: isCirrhosis ? "Advanced liver disease can lead to swelling, jaundice, or confusion over time. These features need monitoring." : "Digestion-related symptoms often worsen with trigger foods, stress, or irregular meals." },
          { name: isCirrhosis ? "Portal hypertension or liver failure risk" : "Food-triggered symptom flares", confidence: 0.58, rationale: isCirrhosis ? "Cirrhosis can lead to serious complications affecting the belly, blood flow, or brain. Warning signs need urgent care." : "Certain foods or meal timing can trigger reflux or bowel symptoms in some people." },
          { name: "Poor appetite or fatigue", confidence: 0.52, rationale: "Longstanding digestive illness can reduce food intake and energy. Simple meals may be easier to tolerate." },
          { name: "Chronic symptom relapse", confidence: 0.48, rationale: "Digestive conditions often flare again when triggers return or the disease progresses. Persistent worsening needs reassessment." },
        ],
        tests: [
          { name: isCirrhosis ? "Liver function tests and bilirubin" : "Clinical abdominal examination", reason: isCirrhosis ? "Key blood tests to assess liver injury and jaundice." : "Helps assess reflux, bowel symptoms, and tenderness pattern." },
          { name: isCirrhosis ? "Abdominal ultrasound" : "Stool or digestive review if indicated", reason: isCirrhosis ? "Useful to look for fluid, liver changes, or portal problems." : "May help when bowel symptoms are persistent or unclear." },
          { name: isCirrhosis ? "Complete Blood Count (CBC)" : "Follow-up medical review", reason: isCirrhosis ? "Important because cirrhosis can affect blood counts and bleeding risk." : "Needed if symptoms are ongoing or affecting daily life." },
        ],
        remedies: [
          { name: "Small Light Meals", tags: ["small portions/day"], howToUse: "Use smaller meals rather than large heavy ones and keep foods simple if symptoms flare. Avoid oily or very spicy foods if they worsen discomfort.", notes: "Supportive only and not a substitute for medical care." },
          { name: isCirrhosis ? "Avoid Alcohol Completely" : "Avoid Trigger Foods", tags: ["through the day"], howToUse: isCirrhosis ? "Do not use alcohol at all if liver disease is present. Keep meals simple and follow medical advice closely." : "Avoid foods that clearly trigger reflux, bloating, or bowel discomfort for you. Keep a simple pattern of meals if possible.", notes: isCirrhosis ? "Seek urgent care for vomiting blood, confusion, or belly swelling." : "Get medical review for weight loss, bleeding, or severe pain." },
          { name: "Rest and Hydration", tags: ["2-3 times/day"], howToUse: "Take fluids and rest in small steady amounts through the day if tired or nauseated. Do not force large meals if symptoms are active.", notes: "Persistent vomiting, dehydration, or severe pain needs medical care." },
        ],
        redFlags: [
          isCirrhosis ? "Vomiting blood, black stool, confusion, or severe belly swelling." : "Trouble swallowing, vomiting blood, or black or bloody stool.",
          "Rapid weight loss, persistent severe pain, or dehydration.",
          "Jaundice, fainting, or symptoms getting steadily worse.",
        ],
      };
    }
    case "hypothyroidism":
    case "hyperthyroidism": {
      const primary = match.label;
      const isHyper = match.id === "hyperthyroidism";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} can affect energy, weight, temperature tolerance, bowels, mood, and heart rate. Blood tests are needed to confirm thyroid hormone imbalance.` },
          { name: isHyper ? "Overactive thyroid symptoms" : "Low-thyroid slowdown symptoms", confidence: 0.66, rationale: isHyper ? "Palpitations, tremor, heat intolerance, and weight loss can happen when thyroid hormone is high." : "Fatigue, cold intolerance, dry skin, constipation, and slowed thinking can happen when thyroid hormone is low." },
          { name: "Heart rhythm or blood pressure impact", confidence: 0.54, rationale: "Thyroid disease can affect pulse and blood pressure. Medical monitoring helps prevent complications." },
          { name: "Metabolic imbalance", confidence: 0.5, rationale: "Thyroid hormone changes can affect many body systems at once. Ongoing symptoms need follow-up even if mild." },
          { name: "Chronic endocrine condition", confidence: 0.48, rationale: "Thyroid disorders often need long-term monitoring and medication adjustment. Home care is supportive only." },
        ],
        tests: [
          { name: "TSH blood test", reason: "The main screening test for thyroid function." },
          { name: "Free T4 or thyroid hormone panel", reason: "Helps confirm whether thyroid hormone is low or high." },
          { name: "Pulse and blood pressure check", reason: "Useful because thyroid disease can affect the heart and circulation." },
        ],
        remedies: [
          { name: "Regular Meals", tags: ["small portions/day"], howToUse: "Keep a regular meal pattern to support energy through the day. Use simple balanced meals rather than skipping food.", notes: "Supportive only and not a replacement for thyroid treatment." },
          { name: "Consistent Sleep Routine", tags: ["1 time/day"], howToUse: "Keep sleep and waking times steady to support fatigue or restlessness. Rest more if symptoms are making you worn out.", notes: "Seek care for severe palpitations, confusion, or extreme weakness." },
          { name: "Gentle Activity if Stable", tags: ["1 time/day"], howToUse: "If symptoms are stable, gentle walking or stretching may help energy and stiffness. Stop if you feel chest pain, marked palpitations, or dizziness.", notes: "Avoid overexertion during uncontrolled symptoms." },
        ],
        redFlags: [
          "Severe palpitations, chest pain, fainting, or confusion.",
          "Extreme drowsiness, swelling, or worsening weakness.",
          "Rapid symptom progression or inability to manage daily activities.",
        ],
      };
    }
    case "down_syndrome":
    case "sickle_cell":
    case "cystic_fibrosis": {
      const primary = match.label;
      const isSickle = match.id === "sickle_cell";
      const isCF = match.id === "cystic_fibrosis";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} is a long-term genetic condition that often needs specialist care and regular monitoring. Symptoms and daily challenges differ depending on the disease.` },
          { name: isSickle ? "Pain crisis or anemia risk" : isCF ? "Chronic lung and digestive involvement" : "Associated developmental or medical support needs", confidence: 0.66, rationale: isSickle ? "Sickle cell disease can cause severe pain, anemia, or infection risk during flares." : isCF ? "Cystic fibrosis often affects the lungs and digestion through thick mucus and poor absorption." : "Down syndrome can affect development and may come with heart, thyroid, hearing, or vision issues." },
          { name: "Chronic complication risk", confidence: 0.56, rationale: "Genetic diseases may affect multiple body systems over time. Regular follow-up helps prevent complications." },
          { name: "Fatigue or nutrition-related strain", confidence: 0.5, rationale: "Energy, growth, or weight can be affected depending on the condition and disease stage. Nutritional support may help comfort but not replace treatment." },
          { name: "Need for structured long-term care", confidence: 0.48, rationale: "Long-term conditions benefit from regular monitoring and clear care plans. Home measures are only supportive." },
        ],
        tests: [
          { name: "Specialist clinical review", reason: "Important because inherited diseases often need structured follow-up." },
          { name: isSickle ? "Complete Blood Count (CBC)" : isCF ? "Lung and nutrition review" : "Screening based on associated conditions", reason: isSickle ? "Useful to assess anemia or crisis severity." : isCF ? "Helpful because cystic fibrosis often affects breathing and nutrition." : "Needed because associated issues may involve the heart, thyroid, hearing, or vision." },
          { name: "Disease-specific monitoring tests", reason: "Monitoring depends on the exact inherited condition and current symptoms." },
        ],
        remedies: [
          { name: "Regular Meals and Water", tags: ["small portions/day"], howToUse: "Use regular meals and steady fluids through the day unless a clinician has given restrictions. This helps support energy and recovery.", notes: "Supportive only and not a substitute for specialist care." },
          { name: "Rest During Flares", tags: ["rest periods/day"], howToUse: "Rest more during pain, fatigue, infection, or breathing flare-ups. Reduce heavy activity until symptoms settle or a clinician advises otherwise.", notes: "Seek urgent care for chest symptoms, severe pain, or dehydration." },
          { name: "Keep Follow-Up Routine", tags: ["1 time/day"], howToUse: "Track symptoms and keep regular appointments, medicines, and long-term care plans up to date. Early review helps if symptoms change.", notes: "Long-term inherited conditions need structured medical care." },
        ],
        redFlags: [
          isSickle ? "Chest pain, breathing difficulty, severe pain crisis, or fever." : isCF ? "Severe breathing difficulty, blue lips, or dehydration." : "Sudden major change in alertness, breathing, or ability to function.",
          "Repeated vomiting, severe weakness, or poor fluid intake.",
          "Symptoms worsening quickly or new serious organ-related symptoms.",
        ],
      };
    }
    case "rheumatoid_arthritis":
    case "lupus":
    case "osteoarthritis":
    case "osteoporosis": {
      const primary = match.label;
      const isOsteoporosis = match.id === "osteoporosis";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} affects joints, bones, or the immune system and often causes ongoing pain, stiffness, or functional limitation. Monitoring is important because symptoms may flare or complications may develop.` },
          { name: isOsteoporosis ? "Fracture risk" : "Joint inflammation or degeneration", confidence: 0.66, rationale: isOsteoporosis ? "Osteoporosis weakens bones and raises the chance of fractures after even mild trauma." : "Inflammation or wear-and-tear can reduce movement and increase pain over time." },
          { name: "Reduced mobility", confidence: 0.56, rationale: "Pain and stiffness can limit walking, gripping, or daily activity. Gentle movement can help comfort if it is safe." },
          { name: "Flare-related fatigue", confidence: 0.5, rationale: "Autoimmune and chronic pain disorders can worsen energy and sleep. Good pacing is often needed." },
          { name: "Long-term musculoskeletal strain", confidence: 0.48, rationale: "Joint or bone disease can slowly affect posture, balance, and function. Reassessment is important if symptoms change." },
        ],
        tests: [
          { name: "Physical joint or bone examination", reason: "A clinician can assess swelling, tenderness, stiffness, and function." },
          { name: isOsteoporosis ? "Bone density test" : "Inflammation or autoimmune blood tests if indicated", reason: isOsteoporosis ? "The main test to assess bone thinning." : "May help evaluate rheumatoid arthritis or lupus activity." },
          { name: "X-ray or imaging if needed", reason: "Helpful when pain, deformity, or fracture concern needs clarification." },
        ],
        remedies: [
          { name: "Warm Compress", tags: ["15-20 min/day"], howToUse: "Place a warm towel or wrapped heat pack on stiff or aching joints for 15-20 minutes. Keep the heat gentle and stop if it worsens swelling.", notes: "Supportive only and not a replacement for arthritis or bone treatment." },
          { name: "Gentle Movement", tags: ["1 time/day"], howToUse: "Use gentle stretching or short walks if movement is still comfortable. Stop if pain rises sharply or you suspect a fracture.", notes: "Avoid strain during strong flares or injury." },
          { name: "Rest and Joint Pacing", tags: ["rest periods/day"], howToUse: "Alternate activity with rest so joints or bones are not overworked. Spread tasks across the day if pain or fatigue is significant.", notes: "Seek care for sudden severe pain, swelling, or possible fracture." },
        ],
        redFlags: [
          "Sudden chest pain, severe shortness of breath, or neurologic symptoms.",
          "Hot swollen joint with fever, or sudden inability to bear weight.",
          isOsteoporosis ? "Back pain after minor trauma or suspected fracture." : "Severe flare, rash, or symptoms affecting the kidneys, lungs, or nerves.",
        ],
      };
    }
    case "eczema":
    case "psoriasis":
    case "acne": {
      const primary = match.label;
      return {
        conditions: [
          { name: primary, confidence: 0.82, rationale: `${primary} commonly affects the skin and may cause irritation, inflammation, itching, scaling, or spots depending on the condition. Persistent or severe skin symptoms need review if home care is not enough.` },
          { name: "Skin barrier irritation", confidence: 0.64, rationale: "Dryness, friction, sweat, or harsh products can worsen skin symptoms. Gentle skin care often helps comfort." },
          { name: "Inflammatory skin flare", confidence: 0.58, rationale: "Chronic skin conditions often flare with stress, weather change, or irritation. The skin may become red, itchy, or more sensitive." },
          { name: "Secondary infection risk", confidence: 0.5, rationale: "Broken skin or picking can lead to bacterial irritation or infection. Worsening pain, pus, or spreading redness needs attention." },
          { name: "Recurring skin symptoms", confidence: 0.48, rationale: "Skin disorders often improve and flare again over time. Repeated episodes may need tailored treatment." },
        ],
        tests: [
          { name: "Skin examination", reason: "A clinician can usually identify common skin disease by appearance and pattern." },
          { name: "Swab or scraping if needed", reason: "Helpful if infection or a fungal look-alike is suspected." },
          { name: "Review of triggers and skin-care routine", reason: "Important because soaps, cosmetics, or friction may worsen symptoms." },
        ],
        remedies: [
          { name: "Gentle Unscented Cleansing", tags: ["1-2 times/day"], howToUse: "Wash with mild unscented cleanser or plain water and pat the skin dry without scrubbing. Avoid harsh soaps and strong fragrances.", notes: "Supportive only and not a replacement for medical treatment when the rash is severe." },
          { name: "Plain Moisturizer", tags: ["1-2 times/day"], howToUse: "Apply a simple fragrance-free moisturizer to dry skin after washing while the skin is slightly damp. Reapply if the skin feels very dry.", notes: "Avoid products that sting badly or clearly worsen the rash." },
          { name: "Avoid Picking and Irritation", tags: ["through the day"], howToUse: "Avoid scratching, squeezing, or rubbing the affected skin. Keep nails short and use loose breathable clothing when friction worsens symptoms.", notes: "Seek care for pus, spreading redness, or severe swelling." },
        ],
        redFlags: [
          "Rapidly spreading redness, pus, or severe swelling.",
          "Fever, severe pain, or skin that becomes hot and tender.",
          "Eye involvement, widespread blistering, or symptoms not improving.",
        ],
      };
    }
    case "pcos":
    case "ed":
    case "malnutrition":
    case "obesity":
    case "cataract":
    case "glaucoma":
    case "hearing_loss": {
      const primary = match.label;
      const isGlaucoma = match.id === "glaucoma";
      return {
        conditions: [
          { name: primary, confidence: 0.8, rationale: `${primary} is a real health condition that often needs targeted medical assessment rather than symptom guessing alone. Daily symptoms and long-term risks depend on the exact diagnosis and severity.` },
          { name: "Condition-related functional impact", confidence: 0.62, rationale: "These conditions can affect daily activities, safety, or quality of life if they worsen. Proper review helps guide treatment." },
          { name: "Long-term progression risk", confidence: 0.56, rationale: "Some of these problems progress gradually over time if not monitored. Early follow-up can help reduce complications." },
          { name: "Related metabolic or hormonal factors", confidence: 0.5, rationale: "Hormones, weight, circulation, or nutrition may contribute depending on the disease. Assessment should be specific to the condition." },
          { name: "Need for disease-specific review", confidence: 0.48, rationale: "A condition-specific check is more useful than generic symptom treatment. Home care is only supportive." },
        ],
        tests: [
          { name: match.id === "pcos" ? "Hormone and menstrual review" : match.id === "ed" ? "Blood pressure, sugar, and hormone review" : match.id === "malnutrition" ? "Weight and nutrition assessment" : match.id === "obesity" ? "Blood pressure, blood sugar, and metabolic screening" : match.id === "hearing_loss" ? "Hearing test" : "Eye examination", reason: "A focused assessment is needed because the right tests depend on the exact condition." },
          { name: match.id === "glaucoma" ? "Eye pressure check" : "Physical examination", reason: match.id === "glaucoma" ? "Important because glaucoma can silently damage vision." : "Helps identify severity and related health issues." },
          { name: "Follow-up specialist review if needed", reason: "Useful when symptoms affect vision, hearing, hormones, weight, or sexual function." },
        ],
        remedies: [
          { name: "Regular Meals and Water", tags: ["small portions/day"], howToUse: "Keep meals and fluids steady through the day and avoid long gaps if energy is low or appetite changes. Use simple balanced meals where possible.", notes: "Supportive only and not a treatment for the underlying condition." },
          { name: "Sleep and Stress Routine", tags: ["1 time/day"], howToUse: "Keep a regular sleep schedule and reduce obvious stressors where you can. This may help energy, appetite, and coping while proper care is arranged.", notes: "Seek care if symptoms are significantly affecting daily life or worsening." },
          { name: isGlaucoma ? "Avoid Delaying Eye Care" : "Gentle Daily Activity if Stable", tags: ["1 time/day"], howToUse: isGlaucoma ? "Do not rely on home remedies for glaucoma because vision can be damaged silently. Keep specialist appointments and use prescribed treatment exactly as directed." : "If you are otherwise stable, gentle movement or routine activity may support overall health. Stop if symptoms worsen or a clinician has advised restrictions.", notes: isGlaucoma ? "Urgent review is needed for sudden eye pain or vision loss." : "This is supportive care only." },
        ],
        redFlags: [
          isGlaucoma ? "Sudden eye pain, vomiting, halos, or rapid vision loss." : "Sudden major worsening, collapse, or inability to function safely.",
          "Severe weakness, dehydration, or symptoms affecting consciousness.",
          "Rapid symptom progression or new urgent organ-related symptoms.",
        ],
      };
    }
    default:
      return null;
  }
}

function conditionFallbacksForSymptoms(symptoms, language = "en") {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    return buildNamedDiseaseAnalysis(namedDisease)?.conditions || [];
  }
  const symptomProfile = detectSymptomProfile(symptomText);

  if (symptomProfile === "cardiac_emergency") {
    return [
      {
        name: "Possible heart attack (acute coronary syndrome)",
        confidence: 0.9,
        rationale:
          "Chest pressure or pain spreading to the arm, jaw, or back can suggest a heart attack. Shortness of breath, sweating, nausea, or sudden weakness make this especially urgent.",
      },
      {
        name: "Unstable angina",
        confidence: 0.74,
        rationale:
          "Reduced blood flow to the heart can cause chest pain or pressure even before a full heart attack develops. Symptoms that happen at rest or worsen suddenly need urgent evaluation.",
      },
      {
        name: "Other serious cardiac emergency",
        confidence: 0.62,
        rationale:
          "Sudden severe chest symptoms can also happen with other dangerous heart conditions. Emergency assessment is needed to rule out life-threatening causes quickly.",
      },
    ];
  }

  if (symptomProfile === "stroke_emergency") {
    return [
      {
        name: "Possible stroke",
        confidence: 0.9,
        rationale:
          "Sudden one-sided weakness, facial drooping, or slurred speech can mean a stroke. Immediate emergency treatment is critical to reduce brain injury.",
      },
      {
        name: "Transient ischemic attack (TIA)",
        confidence: 0.72,
        rationale:
          "Stroke-like symptoms that improve quickly can still be a serious warning sign. A TIA needs urgent medical evaluation because a major stroke can follow.",
      },
      {
        name: "Other acute neurologic emergency",
        confidence: 0.6,
        rationale:
          "Sudden speech or movement problems can come from other urgent brain or nerve conditions. Emergency assessment is needed right away.",
      },
    ];
  }

  if (symptomProfile === "dengue") {
    return [
      {
        name: "Dengue fever",
        confidence: 0.82,
        rationale:
          "Dengue often causes high fever with body aches, headache, pain behind the eyes, or rash. Warning signs such as severe abdominal pain, bleeding, or repeated vomiting need urgent care.",
      },
      {
        name: "Viral fever",
        confidence: 0.64,
        rationale:
          "Other viral infections can also cause fever, body pain, and weakness. A blood test helps separate dengue from other viral illnesses.",
      },
      {
        name: "Dehydration from fever",
        confidence: 0.58,
        rationale:
          "High fever and poor intake can quickly cause dehydration. Dry mouth, weakness, dizziness, or dark urine make this more likely.",
      },
      {
        name: "Mosquito-borne viral illness",
        confidence: 0.54,
        rationale:
          "Other mosquito-borne infections can look similar in the early stage. Travel history, local outbreaks, and blood tests help clarify the cause.",
      },
    ];
  }

  if (symptomProfile === "typhoid") {
    return [
      {
        name: "Typhoid fever",
        confidence: 0.8,
        rationale:
          "Typhoid usually causes ongoing fever and may also cause stomach pain, weakness, diarrhea, or constipation. It needs medical confirmation and treatment because it is a bacterial infection.",
      },
      {
        name: "Enteric fever",
        confidence: 0.72,
        rationale:
          "Enteric fever is a broader term that includes typhoid-like bacterial illness. Persistent fever with abdominal symptoms makes this important to test for.",
      },
      {
        name: "Dehydration from fever or diarrhea",
        confidence: 0.56,
        rationale:
          "Long fever and stomach symptoms can reduce fluid intake and increase losses. Weakness, dizziness, or dark urine make dehydration more likely.",
      },
      {
        name: "Intestinal infection",
        confidence: 0.52,
        rationale:
          "Other gut infections can also cause fever and abdominal symptoms. Testing helps tell typhoid apart from other infections.",
      },
    ];
  }

  if (symptomProfile === "jaundice") {
    return [
      {
        name: "Jaundice from liver or bile problem",
        confidence: 0.8,
        rationale:
          "Yellow eyes or skin means bilirubin is building up in the body. Problems in the liver, gallbladder, or bile ducts are common causes in adults.",
      },
      {
        name: "Hepatitis or liver inflammation",
        confidence: 0.7,
        rationale:
          "Liver inflammation can cause jaundice, dark urine, tiredness, and pain on the right side of the abdomen. Blood tests are needed to look for liver injury and infection.",
      },
      {
        name: "Blocked bile flow",
        confidence: 0.6,
        rationale:
          "A gallstone or other blockage in the bile ducts can cause jaundice and pale stool. It can become urgent if there is fever or severe abdominal pain.",
      },
      {
        name: "Hemolysis or blood-cell breakdown",
        confidence: 0.5,
        rationale:
          "Rapid red blood cell breakdown can also raise bilirubin and cause jaundice. Blood tests help check for this less common cause.",
      },
    ];
  }

  if (symptomProfile === "injury") {
    const handRelated = /\b(hand|wrist|finger|thumb|palm)\b/.test(symptomText);
    const locationLabel = handRelated ? "hand" : "injured area";

    return [
      {
        name: handRelated ? "Bone fracture (hand)" : "Possible bone fracture",
        confidence: 0.78,
        rationale:
          `A broken ${locationLabel === "hand" ? "hand usually means a fracture in one of the hand bones" : "area can mean a cracked or broken bone"}. Pain, swelling, deformity, or difficulty moving the area make this more likely.`,
      },
      {
        name: handRelated ? "Soft tissue injury (hand)" : "Soft tissue injury",
        confidence: 0.62,
        rationale:
          "Injury can also affect muscles, tendons, or ligaments around the painful area. Swelling, bruising, and pain with movement are common in soft tissue injury.",
      },
      {
        name: handRelated ? "Joint dislocation (hand or finger)" : "Joint dislocation",
        confidence: 0.58,
        rationale:
          "A fall or direct injury can force a joint out of place and cause sudden pain. Visible deformity, severe swelling, or inability to move the joint would support this.",
      },
      {
        name: handRelated ? "Severe sprain or ligament injury" : "Severe sprain or ligament injury",
        confidence: 0.54,
        rationale:
          "A strong twist or impact can overstretch or tear ligaments. Pain, swelling, and reduced movement can look similar to a fracture at first.",
      },
      {
        name: handRelated ? "Bone bruise or contusion" : "Bone bruise or contusion",
        confidence: 0.5,
        rationale:
          "A hard impact can cause deep bruising around bone and soft tissue. Tenderness, swelling, and pain after injury can happen even without a full fracture.",
      },
    ];
  }

  if (symptomProfile === "fever_headache") {
    return [
      {
        name: "Viral fever or seasonal flu",
        confidence: 0.78,
        rationale:
          "Fever and headache together commonly occur with viral infections such as seasonal flu. Body aches, tiredness, cough, or sore throat can appear with this pattern.",
      },
      {
        name: "Dengue-like viral fever",
        confidence: 0.68,
        rationale:
          "Dengue can cause fever with strong headache, body aches, eye pain, or rash. It is important to test early when these symptoms are present in dengue-prone areas.",
      },
      {
        name: "Dehydration-related headache",
        confidence: 0.64,
        rationale:
          "Fever can increase sweating and fluid loss, which may trigger or worsen headache. Thirst, dark urine, dizziness, or weakness can support this possibility.",
      },
      {
        name: "Tension headache",
        confidence: 0.6,
        rationale:
          "Illness, poor sleep, and muscle tightness can trigger a tension-type headache. It usually feels like pressure around the head or neck.",
      },
      {
        name: "Migraine triggered by illness",
        confidence: 0.56,
        rationale:
          "Fever, poor sleep, or dehydration can trigger migraine in some people. One-sided throbbing pain, nausea, or light sensitivity would support this pattern.",
      },
      {
        name: "Sinus infection or sinus pressure",
        confidence: 0.52,
        rationale:
          "Sinus pressure can cause headache and may occur with fever when infection is present. Blocked nose, facial pain, or thick mucus makes this more likely.",
      },
    ];
  }

  if (symptomProfile === "stomach") {
    return [
      {
        name: "Indigestion (Dyspepsia)",
        confidence: 0.72,
        rationale:
          "Stomach pain is commonly linked with indigestion after eating or drinking. This can cause upper belly discomfort, fullness, burning, or bloating.",
      },
      {
        name: "Gastritis or mild stomach irritation",
        confidence: 0.68,
        rationale:
          "Irritation of the stomach lining can cause stomach pain or burning. Spicy foods, stress, infection, or certain pain relievers may make it worse.",
      },
      {
        name: "Gas or bloating",
        confidence: 0.64,
        rationale:
          "Gas buildup can create cramping, pressure, or moving stomach discomfort. It is often related to meals, carbonated drinks, or slow digestion.",
      },
      {
        name: "Constipation",
        confidence: 0.6,
        rationale:
          "Constipation can cause lower belly pain, pressure, or cramping. It may happen when stools are hard, infrequent, or difficult to pass.",
      },
      {
        name: "Stomach infection or food-related irritation",
        confidence: 0.58,
        rationale:
          "A mild stomach infection or food irritation can cause stomach pain. Nausea, vomiting, diarrhea, or fever would make this more likely.",
      },
    ];
  }

  if (symptomProfile === "headache") {
    return [
      {
        name: "Tension headache",
        confidence: 0.72,
        rationale:
          "Headache is often linked with muscle tension, stress, or long screen time. It commonly feels like pressure around the head or neck.",
      },
      {
        name: "Migraine",
        confidence: 0.66,
        rationale:
          "Migraine can cause stronger headache that may come with light sensitivity or nausea. Recurrent one-sided pain can fit this pattern.",
      },
      {
        name: "Dehydration-related headache",
        confidence: 0.62,
        rationale:
          "Low fluid intake can trigger headache and tiredness. It may feel worse after heat exposure, sweating, or skipping drinks.",
      },
      {
        name: "Sinus pressure",
        confidence: 0.56,
        rationale:
          "Sinus congestion can cause forehead or facial pressure with headache. Blocked nose, mucus, or facial tenderness would support this.",
      },
      {
        name: "Sleep or fatigue-related headache",
        confidence: 0.54,
        rationale:
          "Poor sleep and fatigue can make headaches more likely. Rest, hydration, and regular meals often help mild cases.",
      },
    ];
  }

  if (symptomProfile === "respiratory") {
    return [
      {
        name: "Common cold",
        confidence: 0.74,
        rationale:
          "Cough, throat irritation, or runny nose commonly fit a viral cold. Symptoms often build gradually and improve with rest and fluids.",
      },
      {
        name: "Throat irritation",
        confidence: 0.66,
        rationale:
          "Dry air, dust, reflux, or repeated coughing can irritate the throat. This can create cough, soreness, or a scratchy feeling.",
      },
      {
        name: "Seasonal allergy",
        confidence: 0.6,
        rationale:
          "Allergies can cause sneezing, runny nose, congestion, and cough. Itching eyes or repeated symptoms around dust or pollen support this.",
      },
      {
        name: "Mild bronchial irritation",
        confidence: 0.56,
        rationale:
          "Cough can come from irritation in the airways after a cold or exposure to smoke or dust. It may linger even after other symptoms improve.",
      },
      {
        name: "Acid reflux irritation",
        confidence: 0.5,
        rationale:
          "Reflux can trigger cough or throat burning, especially after meals or when lying down. Sour taste or chest burning would support this.",
      },
    ];
  }

  return [
    {
      name: "Mild self-limited illness",
      confidence: 0.62,
      rationale:
        "Many common symptoms are caused by short-term irritation, fatigue, or a mild viral illness. Rest and fluids often help while monitoring changes.",
    },
    {
      name: "Dehydration or low fluid intake",
      confidence: 0.58,
      rationale:
        "Low fluid intake can worsen many symptoms such as headache, fatigue, dizziness, or cramps. Drinking enough fluids may reduce mild discomfort.",
    },
    {
      name: "Stress or poor sleep",
      confidence: 0.55,
      rationale:
        "Stress and poor sleep can make pain, fatigue, and body discomfort feel stronger. A steady sleep schedule and relaxation may help mild symptoms.",
    },
    {
      name: "Diet-related irritation",
      confidence: 0.52,
      rationale:
        "Heavy, spicy, or irregular meals can contribute to discomfort in many people. Simple meals and hydration may help symptoms settle.",
    },
    {
      name: "Early infection or inflammation",
      confidence: 0.5,
      rationale:
        "Some symptoms can appear early before a clearer pattern develops. Watch for fever, worsening pain, spreading symptoms, or weakness.",
    },
  ];
}

function normalizePossibleConditions(conditions, symptoms, language = "en") {
  const symptomCount = Array.isArray(symptoms) ? symptoms.length : 0;
  const maxConfidence = symptomCount <= 1 ? 0.78 : symptomCount <= 3 ? 0.85 : 0.92;
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    return (buildNamedDiseaseAnalysis(namedDisease)?.conditions || [])
      .map((condition) => ({
        name: cleanText(condition?.name),
        confidence: Number(
          Math.max(clampConfidence(condition?.confidence, maxConfidence), 0.48).toFixed(2),
        ),
        rationale: cleanText(condition?.rationale),
      }))
      .filter((condition) => condition.name && condition.rationale)
      .slice(0, 6);
  }
  const symptomProfile = detectSymptomProfile(symptomText);
  const injurySymptoms = symptomProfile === "injury";
  const seen = new Set();
  const normalized = [];

  const cleanRationale = (rationale) => {
    let text = cleanText(rationale);
    text = text
      .replace(/\bbut\s+(details|information|specific symptoms)[^.]*\./gi, "")
      .replace(/\b(details|information)\s+(are|is)\s+missing[^.]*\./gi, "")
      .replace(/\bwithout\s+(other\s+)?(specific\s+)?(details|information)[^.]*\./gi, "")
      .replace(/\bthe\s+lack\s+of\s+(details|information)[^.]*\./gi, "")
      .replace(/\bmore\s+details\s+are\s+needed[^.]*\./gi, "")
      .replace(/\blimited\s+certainty[^.]*\./gi, "")
      .replace(/\bthis\s+remains\s+a\s+(low|moderate)\s+possibility[^.]*\./gi, "")
      .replace(/\s+/g, " ")
      .trim();

    return text || "This can commonly match the reported symptom pattern.";
  };

  const isLowQualityConditionName = (name) =>
    /\b(with mild infection|with mild viral illness|combined with|with stress|with dehydration|due to unknown|possible illness)\b/i.test(
      name,
    );

  const conditionKey = (name) => {
    const normalizedName = cleanText(name).toLowerCase();
    if (/fracture|broken bone/.test(normalizedName)) return "bone-fracture";
    if (/soft tissue/.test(normalizedName)) return "soft-tissue-injury";
    if (/dislocation/.test(normalizedName)) return "joint-dislocation";
    if (/sprain|ligament/.test(normalizedName)) return "sprain-ligament";
    if (/bruise|contusion/.test(normalizedName)) return "bone-bruise";
    if (/heart attack|acute coronary syndrome|unstable angina|cardiac emergency/.test(normalizedName)) return "cardiac-emergency";
    if (/stroke|transient ischemic attack|tia|neurologic emergency/.test(normalizedName)) return "stroke-emergency";
    if (/dengue/.test(normalizedName)) return "dengue";
    if (/typhoid|enteric fever/.test(normalizedName)) return "typhoid";
    if (/jaundice|hepatitis|liver inflammation|blocked bile|bile flow|hemolysis/.test(normalizedName)) return "jaundice";
    if (/viral fever|seasonal flu|\bflu\b/.test(normalizedName)) return "viral-fever-flu";
    if (/dengue/.test(normalizedName)) return "dengue-like-fever";
    if (/tension/.test(normalizedName)) return "tension-headache";
    if (/migraine/.test(normalizedName)) return "migraine";
    if (/dehydration|fluid/.test(normalizedName)) return "dehydration";
    if (/sinus/.test(normalizedName)) return "sinus-pressure";
    if (/indigestion|dyspepsia/.test(normalizedName)) return "indigestion";
    if (/gas|bloating/.test(normalizedName)) return "gas-bloating";
    if (/constipation/.test(normalizedName)) return "constipation";
    if (/gastritis|stomach irritation/.test(normalizedName)) return "gastritis";

    return normalizedName
      .replace(/\([^)]*\)/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  };

  const buildTwoLineRationale = (conditionName, rationale) => {
    const normalizedName = cleanText(conditionName).toLowerCase();

    if (/fracture|broken bone/.test(normalizedName)) {
      return "A broken hand or injured area can mean a bone fracture after trauma. Pain, swelling, deformity, or trouble moving it make this more likely.";
    }
    if (/soft tissue/.test(normalizedName)) {
      return "Injury can also affect muscles, tendons, or ligaments around the painful area. Swelling, bruising, and pain with movement are common in soft tissue injury.";
    }
    if (/dislocation/.test(normalizedName)) {
      return "A strong impact can force a joint out of place and cause sudden pain. Visible deformity or inability to move the joint makes this more likely.";
    }
    if (/sprain|ligament/.test(normalizedName)) {
      return "A severe sprain can happen when ligaments are stretched or torn during injury. Pain and swelling can look similar to a fracture at first.";
    }
    if (/bruise|contusion/.test(normalizedName)) {
      return "A hard impact can cause deep bruising in bone or soft tissue. Tenderness and swelling often appear soon after the injury.";
    }
    if (/heart attack|acute coronary syndrome|unstable angina|cardiac emergency/.test(normalizedName)) {
      return "Chest pressure or pain spreading to the arm, jaw, or back can suggest a heart attack. Immediate emergency treatment is needed.";
    }
    if (/stroke|transient ischemic attack|tia|neurologic emergency/.test(normalizedName)) {
      return "Sudden one-sided weakness, facial drooping, or slurred speech can suggest stroke. Immediate emergency treatment is critical.";
    }
    if (/dengue/.test(normalizedName)) {
      return "Dengue often causes high fever with body aches, headache, eye pain, or rash. Severe abdominal pain, bleeding, or repeated vomiting are danger signs.";
    }
    if (/typhoid|enteric fever/.test(normalizedName)) {
      return "Typhoid often causes ongoing fever with stomach symptoms and weakness. It needs medical confirmation and treatment because it is a bacterial illness.";
    }
    if (/jaundice|hepatitis|liver inflammation|blocked bile|bile flow|hemolysis/.test(normalizedName)) {
      return "Yellow eyes or skin suggest jaundice from a liver, gallbladder, or blood problem. Blood tests and sometimes imaging are needed to find the cause.";
    }
    if (/dengue/.test(normalizedName)) {
      return "Dengue can cause fever with strong headache, body aches, eye pain, or rash. A blood test is needed when dengue is suspected.";
    }
    if (/viral|flu|fever/.test(normalizedName)) {
      return "Fever with headache often fits a viral infection such as seasonal flu. Rest, fluids, and monitoring are important.";
    }
    if (/tension/.test(normalizedName)) {
      return "Tension headache often comes from stress or muscle tightness. It may feel like pressure around the head.";
    }
    if (/migraine/.test(normalizedName)) {
      return "Migraine can cause stronger or one-sided headache. Light sensitivity or nausea may also happen.";
    }
    if (/dehydration|fluid/.test(normalizedName)) {
      return "Low fluid intake can trigger headache and tiredness. Symptoms may worsen after heat or sweating.";
    }
    if (/sinus/.test(normalizedName)) {
      return "Sinus pressure can cause forehead or facial headache. Congestion or facial tenderness makes it more likely.";
    }
    if (/sleep|fatigue/.test(normalizedName)) {
      return "Poor sleep can make headaches feel stronger. Rest, fluids, and regular meals may help.";
    }
    if (/indigestion|dyspepsia/.test(normalizedName)) {
      return "Indigestion can cause upper stomach pain or burning. It often appears after heavy or spicy meals.";
    }
    if (/gas|bloating/.test(normalizedName)) {
      return "Gas can cause cramping or pressure in the belly. It often changes after meals or movement.";
    }
    if (/constipation/.test(normalizedName)) {
      return "Constipation can cause lower belly pressure or cramps. Hard or infrequent stool makes it more likely.";
    }
    if (/gastritis|stomach irritation/.test(normalizedName)) {
      return "Stomach lining irritation can cause pain or burning. Spicy food or pain relievers may worsen it.";
    }

    const cleaned = cleanRationale(rationale);
    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => cleanText(sentence))
      .filter(Boolean);

    const first = sentences[0] || `${conditionName} can match the reported symptoms.`;
    const second = sentences[1] || "Monitor symptoms and seek care if they worsen.";

    return `${first.replace(/[.]+$/, "")}. ${second.replace(/[.]+$/, "")}.`;
  };

  const sourceConditions = language !== "en" && Array.isArray(conditions) && conditions.length >= 4
    ? [...conditions]
    : [
        ...(Array.isArray(conditions) ? conditions : []),
        ...conditionFallbacksForSymptoms(symptoms, language),
      ];

  for (const condition of sourceConditions) {
    const name = cleanText(condition?.name);
    if (!name) continue;
    if (isLowQualityConditionName(name)) continue;
    if (
      injurySymptoms &&
      !/\b(fracture|broken bone|soft tissue|dislocation|sprain|ligament|bruise|contusion|tendon|joint)\b/i.test(
        name,
      )
    ) {
      continue;
    }
    if (
      symptomProfile === "cardiac_emergency" &&
      !/\b(heart attack|acute coronary syndrome|unstable angina|cardiac)\b/i.test(name)
    ) {
      continue;
    }
    if (
      symptomProfile === "stroke_emergency" &&
      !/\b(stroke|transient ischemic attack|tia|neurologic)\b/i.test(name)
    ) {
      continue;
    }
    if (
      symptomProfile === "dengue" &&
      !/\b(dengue|viral fever|dehydration|mosquito)\b/i.test(name)
    ) {
      continue;
    }
    if (
      symptomProfile === "typhoid" &&
      !/\b(typhoid|enteric fever|dehydration|intestinal infection)\b/i.test(name)
    ) {
      continue;
    }
    if (
      symptomProfile === "jaundice" &&
      !/\b(jaundice|hepatitis|liver|bile|hemolysis)\b/i.test(name)
    ) {
      continue;
    }

    const key = conditionKey(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const confidence = clampConfidence(condition?.confidence, maxConfidence);
    normalized.push({
      name,
      confidence: Number(Math.max(confidence, 0.5).toFixed(2)),
      rationale: buildTwoLineRationale(name, condition?.rationale),
    });
  }

  return normalized
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
}

function deriveEmergencyAlert(symptoms, conditions, language = "en") {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const conditionText = (Array.isArray(conditions) ? conditions : [])
    .map((condition) => cleanText(condition?.name).toLowerCase())
    .join(" ");

  if (isCardiacEmergencySymptomText(symptomText) || /\bheart attack|acute coronary syndrome\b/.test(conditionText)) {
    return {
      title: language === "fr" ? "Alerte d’urgence" : "Emergency Alert",
      message: language === "fr"
        ? "Une crise cardiaque est une urgence médicale, et non quelque chose que l’on peut traiter en toute sécurité avec des remèdes naturels à la maison. En cas de tels symptômes, la priorité est une prise en charge médicale immédiate, et non des herbes, des aliments ou un traitement à domicile."
        : "A heart attack is a medical emergency, not something you can safely treat with natural remedies at home. If someone is having these symptoms, the priority is immediate medical care, not herbs, food, or home treatment.",
    };
  }

  if (isStrokeSymptomText(symptomText) || /\bstroke|transient ischemic attack|tia\b/.test(conditionText)) {
    return {
      title: language === "fr" ? "Alerte d’urgence" : "Emergency Alert",
      message: language === "fr"
        ? "Les symptômes d’un AVC constituent une urgence médicale et nécessitent un traitement hospitalier immédiat. Ne comptez pas sur des remèdes naturels ou un traitement à domicile en cas de faiblesse soudaine, de troubles de la parole ou d’affaissement du visage."
        : "Stroke symptoms are a medical emergency and need immediate hospital treatment. Do not rely on natural remedies or home treatment when sudden weakness, slurred speech, or facial drooping appears.",
    };
  }

  if (/\b(anaphylaxis|throat closing|tongue swelling|severe allergic reaction)\b/i.test(symptomText)) {
    return {
      title: "Emergency Alert",
      message:
        "A severe allergic reaction is a medical emergency and can quickly block breathing. Immediate emergency treatment is the priority, not natural remedies or home treatment.",
    };
  }

  if (/\b(major bleeding|exposed bone|severe trauma|crushed chest|unconscious after injury)\b/i.test(symptomText)) {
    return {
      title: "Emergency Alert",
      message:
        "This injury pattern may be a medical emergency and needs urgent professional treatment. Natural remedies are not a safe substitute for emergency care in this situation.",
    };
  }

  return null;
}

function testFallbacksForSymptoms(symptoms, language = "en") {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    return buildNamedDiseaseAnalysis(namedDisease)?.tests || [];
  }
  const symptomProfile = detectSymptomProfile(symptomText);

  if (symptomProfile === "cardiac_emergency") {
    return [
      {
        name: "ECG (electrocardiogram)",
        reason:
          "The fastest key test to look for heart attack or other urgent heart rhythm and blood-flow problems.",
      },
      {
        name: "Cardiac troponin blood test",
        reason:
          "Helps detect damage to the heart muscle and is commonly used in suspected heart attack.",
      },
      {
        name: "Emergency cardiac monitoring and vital signs",
        reason:
          "Needed to watch blood pressure, pulse, oxygen level, and rhythm while urgent treatment is arranged.",
      },
    ];
  }

  if (symptomProfile === "stroke_emergency") {
    return [
      {
        name: "Emergency brain CT scan",
        reason:
          "Used urgently to look for bleeding or blocked blood flow in suspected stroke.",
      },
      {
        name: "Neurologic examination",
        reason:
          "A clinician checks speech, strength, facial movement, vision, and coordination right away.",
      },
      {
        name: "Blood sugar and vital signs check",
        reason:
          "Important because low sugar and severe blood pressure problems can mimic or worsen stroke symptoms.",
      },
    ];
  }

  if (symptomProfile === "dengue") {
    return [
      {
        name: "Dengue NS1 antigen or IgM test",
        reason:
          "Helps confirm dengue infection when fever, body aches, rash, or eye pain suggest it.",
      },
      {
        name: "Complete Blood Count (CBC) with platelet count",
        reason:
          "Checks platelets and blood concentration, which are important in dengue monitoring.",
      },
      {
        name: "Hematocrit or repeat blood count",
        reason:
          "Useful to monitor plasma leakage or worsening illness if dengue is suspected.",
      },
    ];
  }

  if (symptomProfile === "typhoid") {
    return [
      {
        name: "Blood culture",
        reason:
          "One of the most useful tests to confirm typhoid fever, especially early in the illness.",
      },
      {
        name: "Stool test or stool culture",
        reason:
          "Can help detect typhoid bacteria or other intestinal infections causing similar symptoms.",
      },
      {
        name: "Complete Blood Count (CBC)",
        reason:
          "Helps assess infection severity, dehydration risk, and overall illness impact.",
      },
    ];
  }

  if (symptomProfile === "jaundice") {
    return [
      {
        name: "Liver function tests and bilirubin level",
        reason:
          "The main blood tests used to confirm jaundice and measure how much the liver is affected.",
      },
      {
        name: "Hepatitis screening",
        reason:
          "Useful when infection or liver inflammation may be causing yellow eyes or skin.",
      },
      {
        name: "Abdominal ultrasound",
        reason:
          "Can look for gallstones, blocked bile flow, liver swelling, or other structural causes.",
      },
    ];
  }

  if (symptomProfile === "injury") {
    const handRelated = /\b(hand|wrist|finger|thumb|palm)\b/.test(symptomText);
    return [
      {
        name: handRelated ? "Hand or wrist X-ray" : "X-ray of the injured area",
        reason:
          "The best first test to confirm a fracture, dislocation, or other bone injury after trauma.",
      },
      {
        name: "Physical orthopedic examination",
        reason:
          "A clinician can check swelling, deformity, movement, and tenderness to judge how serious the injury is.",
      },
      {
        name: "Circulation and nerve check",
        reason:
          "Important when the injured area is swollen, numb, cold, weak, or hard to move after injury.",
      },
    ];
  }

  if (symptomProfile === "fever_headache") {
    return [
      {
        name: "Temperature and vital signs check",
        reason:
          "Confirms fever level and checks pulse, blood pressure, breathing, and dehydration signs.",
      },
      {
        name: "Complete Blood Count (CBC) with platelet count",
        reason:
          "Helps screen for infection patterns and low platelets, which can matter with fever and headache.",
      },
      {
        name: "Dengue NS1 antigen or IgM test",
        reason:
          "Useful when fever with headache occurs in dengue-prone areas, especially with body aches, rash, or eye pain.",
      },
    ];
  }

  if (symptomProfile === "stomach") {
    return [
      {
        name: "Physical abdominal examination",
        reason:
          "A clinician can check the exact pain location, tenderness, swelling, and whether urgent causes need to be ruled out.",
      },
      {
        name: "Stool test",
        reason:
          "Useful if pain comes with diarrhea, blood, fever, or suspected food-related infection.",
      },
      {
        name: "Complete Blood Count (CBC)",
        reason:
          "Can help look for signs of infection, inflammation, or anemia if symptoms persist or worsen.",
      },
    ];
  }

  if (symptomProfile === "respiratory" || /fever/.test(symptomText)) {
    return [
      {
        name: "Temperature and oxygen check",
        reason:
          "Helps assess fever severity and whether breathing is affected.",
      },
      {
        name: "Throat or respiratory infection test",
        reason:
          "May be useful if sore throat, fever, cough, or symptoms persist beyond a few days.",
      },
      {
        name: "Chest examination",
        reason:
          "A clinician can listen for wheezing or chest infection if cough, chest discomfort, or breathing difficulty is present.",
      },
    ];
  }

  return [
    {
      name: "Basic physical examination",
      reason:
        "A clinician can check vital signs and examine the affected area if symptoms persist or worsen.",
    },
    {
      name: "Complete Blood Count (CBC)",
      reason:
        "Can help screen for infection, inflammation, or anemia when symptoms are unclear or ongoing.",
    },
    {
      name: "Follow-up clinical review",
      reason:
        "Recommended if symptoms do not improve, keep returning, or start affecting daily activities.",
    },
  ];
}

function normalizeRecommendedTests(tests, symptoms, language = "en") {
  const sourceTests = language !== "en" && Array.isArray(tests) && tests.length >= 3
    ? [...tests]
    : [
        ...testFallbacksForSymptoms(symptoms, language),
        ...(Array.isArray(tests) ? tests : []),
      ];

  const seen = new Set();
  const normalized = [];

  for (const test of sourceTests) {
    const name = cleanText(test?.name);
    const reason = cleanText(test?.reason);
    if (!name || !reason) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ name, reason });
  }

  return normalized.slice(0, 3);
}

function normalizeDisclaimer(disclaimer, language = "en") {
  const cleaned = cleanText(disclaimer);
  if (cleaned) return cleaned;

  return language === "fr"
    ? "Ces conseils IA sont fournis uniquement à titre éducatif et d’orientation, et ne constituent pas un diagnostic. Veuillez consulter un professionnel de santé qualifié, surtout si les symptômes sont sévères, persistants ou s’aggravent."
    : "This AI guidance is for education and triage support only, not a diagnosis. Please consult a qualified healthcare professional, especially if symptoms are severe, persistent, or worsening.";
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

function buildSpecificHowToUse(remedyName) {
  const normalized = cleanText(remedyName).toLowerCase();

  if (/ginger/.test(normalized)) {
    return "Simmer 10 g fresh ginger in 250 ml water for 8-10 minutes, then strain and drink warm after food.";
  }
  if (/salt.*gargle|gargle/.test(normalized)) {
    return "Mix 2 g salt in 250 ml warm water and gargle for 20-30 seconds. Spit it out and repeat 2-3 times daily.";
  }
  if (/honey.*lemon|lemon.*honey/.test(normalized)) {
    return "Stir 10 g honey and 15 ml fresh lemon juice into 200 ml warm water. Drink slowly while warm.";
  }
  if (/honey/.test(normalized)) {
    return "Stir 10 g honey into 200 ml warm water and drink slowly. Use once daily if it soothes the throat.";
  }
  if (/turmeric/.test(normalized)) {
    return "Mix 5 g turmeric powder into 250 ml warm milk or warm water. Drink once daily after food if it suits you.";
  }
  if (/rehydration|oral rehydration|ors/.test(normalized)) {
    return "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml at a time.";
  }
  if (/warm water|water/.test(normalized)) {
    return "Drink 150-250 ml warm water slowly. Take small sips 2-3 times during the day.";
  }
  if (/soup|broth/.test(normalized)) {
    return "Take 200-250 ml warm homemade soup or broth in small sips, 1-2 times daily. Keep it light and low in oil.";
  }
  if (/rice|banana|toast|light meal|meal|food/.test(normalized)) {
    return "Eat a small portion such as 100-150 g plain cooked rice or 1 ripe banana. Repeat only if it feels comfortable.";
  }
  if (/cool compress/.test(normalized)) {
    return "Place a cool damp cloth on the forehead for 10-15 minutes. Re-wet it as it warms and keep the body comfortably cool.";
  }
  if (/warm compress|heat|warm towel/.test(normalized)) {
    return "Place a warm towel or wrapped heat pack on the uncomfortable area for 15-20 minutes. Keep the heat gentle to avoid burns.";
  }
  if (/steam/.test(normalized)) {
    return "Pour 500 ml hot water into a bowl and breathe the warm steam gently for 5-10 minutes. Keep your face back to avoid burns.";
  }
  if (/rest|sleep|cool room/.test(normalized)) {
    return "Rest in a shaded or cool room and avoid heavy activity until symptoms settle. Take fluids in small amounts.";
  }

  return null;
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
  const specific = buildSpecificHowToUse(remedy?.name);
  if (!existingRaw) return specific || buildFallbackHowToUse(remedy);

  const narrative = buildNarrativeHowToUse(existingRaw);
  if (narrative) return narrative;

  const cleanedExisting = cleanText(existingRaw)
    .replace(/\s*\d+\s*[\).:-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (hasMetricQuantity(cleanedExisting)) return cleanedExisting;

  return specific || buildFallbackHowToUse(remedy);
}

function extractDosageTag(remedy) {
  const fields = [
    ...(Array.isArray(remedy?.tags) ? remedy.tags : []),
    remedy?.howToUse,
    remedy?.name,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean);
  const joined = fields.join(" ");
  const normalizedName = cleanText(remedy?.name).toLowerCase();

  const frequencyMatch = joined.match(
    /\b(\d+\s*(?:-|–|to)\s*\d+|\d+)\s*(?:times|x)\s*(?:\/|per)?\s*(?:day|daily)\b/i,
  );
  if (frequencyMatch) {
    return frequencyMatch[0]
      .replace(/\s+/g, " ")
      .replace(/\s*(?:per)\s*/i, "/")
      .replace(/\sdaily\b/i, "/day")
      .trim();
  }

  const cupMatch = joined.match(
    /\b(\d+\s*(?:-|–|to)\s*\d+|\d+)\s*(?:cup|cups)\s*(?:\/|per)?\s*(?:day|daily)\b/i,
  );
  if (cupMatch) {
    return cupMatch[0]
      .replace(/\s+/g, " ")
      .replace(/\s*(?:per)\s*/i, "/")
      .replace(/\sdaily\b/i, "/day")
      .trim();
  }

  const minuteMatch = joined.match(
    /\b(\d+\s*(?:-|–|to)\s*\d+|\d+)\s*(?:min|minute|minutes)\s*(?:\/|per)?\s*(?:day|daily)\b/i,
  );
  if (minuteMatch) {
    return minuteMatch[0]
      .replace(/\s+/g, " ")
      .replace(/minutes?/i, "min")
      .replace(/\s*(?:per)\s*/i, "/")
      .replace(/\sdaily\b/i, "/day")
      .trim();
  }

  const bowlMatch = joined.match(
    /\b(\d+\s*(?:-|–|to)\s*\d+|\d+)\s*(?:bowl|bowls)\s*(?:\/|per)?\s*(?:day|daily)\b/i,
  );
  if (bowlMatch) {
    return bowlMatch[0]
      .replace(/\s+/g, " ")
      .replace(/\s*(?:per)\s*/i, "/")
      .replace(/\sdaily\b/i, "/day")
      .trim();
  }

  if (/rest|sleep|cool room/.test(normalizedName)) {
    return "rest periods/day";
  }
  if (/compress|heat|warm towel|pack/.test(normalizedName)) {
    return "15-20 min/day";
  }
  if (/gargle/.test(normalizedName)) {
    return "2-3 times/day";
  }
  if (/water|rehydration|drink/.test(normalizedName)) {
    return "2-3 times/day";
  }
  if (/tea|ginger|turmeric|honey|lemon/.test(normalizedName)) {
    return "1 cup/day";
  }
  if (/meal|food/.test(normalizedName)) {
    return "small portions/day";
  }

  return "1-2 times/day";
}

function remedyFallbacksForSymptoms(symptoms, language = "en") {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    return buildNamedDiseaseAnalysis(namedDisease)?.remedies || [];
  }
  const symptomProfile = detectSymptomProfile(symptomText);

  const baseRemedies = [
    {
      name: "Warm Water",
      tags: ["2-3 times/day"],
      howToUse:
        "Drink 150-250 ml warm water slowly, 2-3 times during the day. Take small sips if your stomach feels sensitive.",
      notes: "Avoid very hot water. Seek care if symptoms worsen or you cannot keep fluids down.",
    },
    {
      name: "Oral Rehydration Drink",
      tags: ["2-3 times/day"],
      howToUse:
        "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml at a time, especially after vomiting or diarrhea.",
      notes: "Use clean water and correct measurements. Seek care for severe dehydration, confusion, or very low urination.",
    },
    {
      name: "Rest and Light Meals",
      tags: ["small portions/day"],
      howToUse:
        "Eat small portions of plain foods such as rice, banana, toast, or soup. Avoid oily, spicy, or heavy meals for 24 hours.",
      notes: "Stop any food that worsens symptoms. This does not replace medical care for severe or persistent pain.",
    },
    {
      name: "Warm Compress",
      tags: ["15-20 min/day"],
      howToUse:
        "Place a warm towel or wrapped heat pack on the uncomfortable area for 15-20 minutes. Keep the heat gentle to avoid burns.",
      notes: "Do not use strong heat on numb skin, swelling, injury, or severe unexplained pain.",
    },
    {
      name: "Ginger Tea",
      tags: ["1 cup/day", "after meals"],
      howToUse:
        "Simmer 10 g fresh ginger in 250 ml water for 8-10 minutes, then strain and drink warm. Start with one cup after food.",
      notes: "Avoid if ginger worsens reflux or if you have gallbladder disease, bleeding risk, or are on blood thinners unless a clinician approves.",
    },
  ];

  if (symptomProfile === "cardiac_emergency") {
    return [
      {
        name: "Rest in a Supported Sitting Position",
        tags: ["while awaiting care"],
        howToUse:
          "Have the person sit upright or half-sitting with the back supported and movement kept to a minimum. Stay as calm as possible while urgent medical help is being arranged.",
        notes: "This is supportive care only and does not treat a heart attack. Call emergency services immediately and do not delay hospital care.",
      },
      {
        name: "Loosen Tight Clothing",
        tags: ["while awaiting care"],
        howToUse:
          "Loosen any tight collar, belt, scarf, or chest clothing to make breathing easier. Keep the person warm and still without forcing them to lie flat if breathing feels worse.",
        notes: "Do not force activity or walking. Immediate emergency treatment is still the priority.",
      },
      {
        name: "Small Sips of Water Only if Fully Alert",
        tags: ["only if safe"],
        howToUse:
          "If the mouth is very dry and the person is fully awake, not vomiting, and swallowing normally, only tiny sips of water may be given. Stop at once if swallowing is difficult, nausea appears, or symptoms worsen.",
        notes: "Do not give food, large drinks, or home remedies that could delay urgent care.",
      },
    ];
  }

  if (symptomProfile === "stroke_emergency") {
    return [
      {
        name: "Keep the Person Resting Safely",
        tags: ["while awaiting care"],
        howToUse:
          "Keep the person at rest with the head slightly raised if they are awake and breathing comfortably. Avoid walking, standing, or sudden movement while urgent medical help is being arranged.",
        notes: "Stroke is a medical emergency and needs hospital treatment right away.",
      },
      {
        name: "Do Not Give Food or Drink",
        tags: ["until assessed"],
        howToUse:
          "Do not give food, drink, or oral remedies if speech is slurred, the face is drooping, or swallowing may be unsafe. Keep the mouth clear and wait for emergency medical assessment.",
        notes: "Swallowing may be impaired during stroke, which raises the risk of choking.",
      },
      {
        name: "Recovery Position if Drowsy or Vomiting",
        tags: ["only if needed"],
        howToUse:
          "If the person becomes drowsy or vomits but is still breathing, gently turn them onto their side with the head supported. Keep the airway clear and continue monitoring until help arrives.",
        notes: "Call emergency services immediately and seek urgent care without delay.",
      },
    ];
  }

  if (symptomProfile === "dengue") {
    return [
      {
        name: "Homemade Rehydration Drink",
        tags: ["2-3 times/day"],
        howToUse:
          "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml often through the day to support hydration.",
        notes: "Seek urgent care for bleeding, severe abdominal pain, repeated vomiting, or extreme weakness.",
      },
      {
        name: "Light Soup or Broth",
        tags: ["1-2 bowls/day"],
        howToUse:
          "Take 200-250 ml warm homemade soup or broth in small sips, 1-2 times daily. Keep it light and low in oil.",
        notes: "Stop if vomiting worsens. Dengue needs medical monitoring when symptoms are severe.",
      },
      {
        name: "Water and Rest",
        tags: ["rest periods/day"],
        howToUse:
          "Rest in a cool room and drink water in small amounts through the day. Avoid heavy activity while fever and body pain continue.",
        notes: "This is only supportive care and not a substitute for medical review.",
      },
    ];
  }

  if (symptomProfile === "typhoid") {
    return [
      {
        name: "Homemade Rehydration Drink",
        tags: ["2-3 times/day"],
        howToUse:
          "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml often if fever, diarrhea, or poor intake are present.",
        notes: "Typhoid usually needs medical treatment and antibiotics. Seek care promptly rather than relying on home remedies alone.",
      },
      {
        name: "Soft Rice or Porridge",
        tags: ["small portions/day"],
        howToUse:
          "Eat a small portion of soft rice or plain porridge 2-3 times daily if tolerated. Keep meals simple and easy to digest.",
        notes: "Avoid spicy, oily, or heavy meals while fever and stomach symptoms continue.",
      },
      {
        name: "Rest and Fluids",
        tags: ["rest periods/day"],
        howToUse:
          "Rest and take water or clear fluids in small amounts throughout the day. Reduce activity while arranging proper medical care.",
        notes: "Home care only supports recovery and does not replace antibiotics for typhoid fever.",
      },
    ];
  }

  if (symptomProfile === "jaundice") {
    return [
      {
        name: "Water and Light Fluids",
        tags: ["2-3 times/day"],
        howToUse:
          "Drink water and clear fluids in small amounts through the day to stay hydrated. Stop alcohol completely while symptoms continue.",
        notes: "Jaundice needs medical evaluation because the cause may involve the liver or bile ducts.",
      },
      {
        name: "Light Meals",
        tags: ["small portions/day"],
        howToUse:
          "Eat small, simple meals such as rice, soup, toast, or other low-fat foods if tolerated. Avoid greasy meals until the cause is checked.",
        notes: "This is only supportive care and does not treat the cause of jaundice.",
      },
      {
        name: "Rest",
        tags: ["rest periods/day"],
        howToUse:
          "Rest and reduce heavy physical activity while waiting for medical review. Keep food and fluid intake gentle if nausea is present.",
        notes: "Get urgent care if jaundice comes with fever, confusion, severe pain, or vomiting.",
      },
    ];
  }

  if (symptomProfile === "injury") {
    return [
      {
        name: "Cold Compress",
        tags: ["10-15 min/day"],
        howToUse:
          "Wrap ice or a cold pack in a clean cloth and place it on the injured area for 10-15 minutes at a time. Repeat several times during the first 24-48 hours.",
        notes: "Do not place ice directly on skin. Go for urgent medical care if there is deformity, severe swelling, numbness, or an open wound.",
      },
      {
        name: "Elevation",
        tags: ["rest periods/day"],
        howToUse:
          "Keep the injured hand or limb raised above heart level whenever possible while resting. This can help reduce swelling after injury.",
        notes: "Stop if positioning increases pain or numbness. This does not replace X-ray or fracture care.",
      },
      {
        name: "Rest and Immobilization",
        tags: ["rest periods/day"],
        howToUse:
          "Avoid using the injured hand or area and keep it as still as possible until examined. Remove rings or tight items early if swelling is increasing.",
        notes: "Do not try to force movement back to normal. Suspected fracture or dislocation needs prompt medical evaluation.",
      },
      {
        name: "Clean Wound Cover",
        tags: ["1-2 times/day"],
        howToUse:
          "If there is a cut, rinse gently with clean water and cover it with a clean cloth or dressing. Keep pressure light unless bleeding is heavy.",
        notes: "Seek urgent care for deep cuts, exposed bone, ongoing bleeding, or dirty wounds after injury.",
      },
      {
        name: "Light Fluids and Meals",
        tags: ["small portions/day"],
        howToUse:
          "Take water and light meals if pain or stress from injury lowers your appetite. Keep food simple while arranging medical care.",
        notes: "This is only supportive care and does not treat the injury itself.",
      },
    ];
  }

  if (symptomProfile === "fever_headache") {
    return [
      {
        name: "Ginger Tea",
        tags: ["1 cup/day"],
        howToUse:
          "Simmer 10 g fresh ginger in 250 ml water for 8-10 minutes, then strain and drink warm after food. Use one cup daily while symptoms are mild.",
        notes: "Avoid if ginger worsens reflux or if you have bleeding risk, gallbladder disease, or use blood thinners unless a clinician approves.",
      },
      {
        name: "Light Soup or Broth",
        tags: ["1-2 bowls/day"],
        howToUse:
          "Take 200-250 ml warm homemade soup or broth in small sips, 1-2 times daily. Keep it light and avoid heavy oil or strong spice.",
        notes: "Stop if nausea worsens. Seek care if fever is high, persistent, or you cannot keep fluids down.",
      },
      {
        name: "Warm Water",
        tags: ["2-3 times/day"],
        howToUse:
          "Drink 150-250 ml warm water slowly, 2-3 times during the day. Take small sips more often if fever makes you sweat.",
        notes: "Avoid very hot water. Seek care for confusion, severe weakness, or very low urination.",
      },
      {
        name: "Homemade Rehydration Drink",
        tags: ["2-3 times/day"],
        howToUse:
          "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml at a time, especially if fever causes sweating or poor intake.",
        notes: "Use clean water and correct measurements. Avoid extra salt and seek care for severe dehydration.",
      },
      {
        name: "Cool Compress",
        tags: ["10-15 min/day"],
        howToUse:
          "Place a cool damp cloth on the forehead for 10-15 minutes. Re-wet it as it warms and keep the body comfortably cool.",
        notes: "Do not use ice directly on skin. Seek urgent care for very high fever, stiff neck, confusion, or worsening headache.",
      },
      {
        name: "Rest in a Cool Room",
        tags: ["rest periods/day"],
        howToUse:
          "Rest in a shaded or cool room and avoid heavy activity until fever settles. Wear light clothing and take fluids in small amounts.",
        notes: "Do not over-bundle during fever. Get medical care if symptoms persist or worsen.",
      },
    ];
  }

  if (symptomProfile === "stomach") {
    return [
      {
        name: "Ginger Tea",
        tags: ["1 cup/day"],
        howToUse:
          "Simmer 8-10 g fresh ginger in 250 ml water for 8 minutes, then strain and drink warm after food. Start with one cup daily.",
        notes: "Avoid if ginger worsens reflux or if you have bleeding risk, gallbladder disease, or use blood thinners unless a clinician approves.",
      },
      {
        name: "Plain Rice or Banana",
        tags: ["small portions/day"],
        howToUse:
          "Eat a small portion such as 100-150 g plain cooked rice or 1 ripe banana. Keep meals simple and repeat only if it feels comfortable.",
        notes: "Avoid oily, spicy, or heavy meals. Seek care for severe pain, repeated vomiting, blood, or fever.",
      },
      {
        name: "Warm Water",
        tags: ["2-3 times/day"],
        howToUse:
          "Drink 150-250 ml warm water slowly, 2-3 times during the day. Take small sips if your stomach feels sensitive.",
        notes: "Avoid very hot water. Seek care if symptoms worsen or you cannot keep fluids down.",
      },
      {
        name: "Homemade Rehydration Drink",
        tags: ["2-3 times/day"],
        howToUse:
          "Mix 1 L clean water with 20 g sugar and 3 g salt until fully dissolved. Sip 100-200 ml at a time after vomiting, diarrhea, or poor intake.",
        notes: "Use clean water and correct measurements. Seek care for severe dehydration, confusion, or very low urination.",
      },
      {
        name: "Warm Compress",
        tags: ["15-20 min/day"],
        howToUse:
          "Place a warm towel or wrapped heat pack on the belly for 15-20 minutes. Keep the heat gentle and stop if pain worsens.",
        notes: "Do not use strong heat on swelling, injury, or severe unexplained pain.",
      },
      {
        name: "Rest and Light Meals",
        tags: ["small portions/day"],
        howToUse:
          "Eat small portions of soft foods such as rice, toast, banana, or soup. Avoid oily, spicy, or heavy meals for 24 hours.",
        notes: "Stop any food that worsens symptoms. This does not replace medical care for severe or persistent pain.",
      },
    ];
  }

  if (symptomProfile === "respiratory") {
    return [
      {
        name: "Warm Salt Water Gargle",
        tags: ["2-3 times/day"],
        howToUse:
          "Mix 2 g salt in 250 ml warm water and gargle for 20-30 seconds. Spit it out and repeat 2-3 times daily.",
        notes: "Not suitable for young children who cannot gargle safely.",
      },
      {
        name: "Honey Warm Water",
        tags: ["1 cup/day", "before bed"],
        howToUse:
          "Stir 10 g honey into 200 ml warm water and drink slowly. Use before bed if cough is disturbing sleep.",
        notes: "Do not give honey to children under 1 year. Use caution with diabetes.",
      },
      ...baseRemedies,
    ];
  }

  return baseRemedies;
}

function normalizeNaturalRemedies(remedies) {
  if (!Array.isArray(remedies)) return [];

  const nonNaturalPattern =
    /\b(paracetamol|acetaminophen|ibuprofen|aspirin|naproxen|cetirizine|loratadine|antihistamine|decongestant|antibiotic|amoxicillin|azithromycin|tablet|capsule|pill|syrup|medicine|medication|drug|ors packet|oral rehydration salt packet|vitamin|zinc|supplement)\b/i;

  return remedies
    .map((remedy) => {
      const name = cleanText(remedy?.name) || "Natural Remedy";
      const notes = cleanText(remedy?.notes);
      const howToUse = normalizeHowToUse({ ...remedy, name });
      const combinedText = `${name} ${notes} ${howToUse}`;

      if (nonNaturalPattern.test(combinedText)) return null;

      return {
        ...remedy,
        name,
        tags: [extractDosageTag({ ...remedy, name, howToUse })],
        notes,
        howToUse,
      };
    })
    .filter(Boolean);
}

function naturalRemedyPriority(remedy) {
  const text = `${cleanText(remedy?.name)} ${cleanText(remedy?.howToUse)} ${cleanText(remedy?.notes)}`.toLowerCase();

  if (/\b(tea|ginger|turmeric|honey|lemon|fennel|cumin|mint|banana|rice|soup|broth|meal|food|toast|oat|porridge)\b/.test(text)) {
    return 0;
  }
  if (/\b(water|drink|hydration|rehydration|fluid)\b/.test(text)) {
    return 1;
  }
  if (/\b(gargle|steam|compress|heat|warm towel)\b/.test(text)) {
    return 2;
  }
  if (/\b(rest|sleep|relax)\b/.test(text)) {
    return 3;
  }

  return 4;
}

function buildNaturalRemedies(remedies, symptoms, emergencyAlert = null, language = "en") {
  const symptomText = (Array.isArray(symptoms) ? symptoms : [])
    .map((s) => cleanText(s).toLowerCase())
    .join(" ");
  const namedDisease = getNamedDiseaseMatch(symptomText);
  if (namedDisease && language === "en") {
    return normalizeNaturalRemedies(remedyFallbacksForSymptoms(symptoms, language)).slice(0, 6);
  }
  const symptomProfile = detectSymptomProfile(symptomText);

  if (language !== "en" && Array.isArray(remedies) && remedies.length >= 3) {
    return normalizeNaturalRemedies(remedies).slice(0, 6);
  }

  if (symptomProfile === "cardiac_emergency" || symptomProfile === "stroke_emergency") {
    return normalizeNaturalRemedies(remedyFallbacksForSymptoms(symptoms, language)).slice(0, 5);
  }

  const seen = new Set();
  const normalized = [];
  const sourceRemedies = [
    ...(Array.isArray(remedies) ? normalizeNaturalRemedies(remedies) : []),
    ...normalizeNaturalRemedies(remedyFallbacksForSymptoms(symptoms, language)),
  ];

  for (const remedy of sourceRemedies) {
    const name = cleanText(remedy?.name);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...remedy, name });
  }

  return normalized
    .map((remedy, index) => ({ remedy, index }))
    .sort((a, b) => {
      const priorityDifference =
        naturalRemedyPriority(a.remedy) - naturalRemedyPriority(b.remedy);
      return priorityDifference || a.index - b.index;
    })
    .map((entry) => entry.remedy)
    .slice(0, 6);
}

/**
 * POST /api/v1/health-solutions
 * body: { symptoms: string[], additionalInfo: {...}, freeText?: string }
 */
export const createHealthSolution = catchAsync(async (req, res, next) => {
  const { symptoms, additionalInfo, freeText, language } = req.body || {};
  const normalizedSymptoms = normalizeSymptoms(symptoms);
  const normalizedAdditionalInfo = normalizeAdditionalInfo(additionalInfo);
  const normalizedFreeText = normalizeFreeText(freeText);
  const normalizedLanguage = normalizeLanguage(language);

  if (!normalizedSymptoms.length) {
    return next(new AppError(400, "Symptoms are required."));
  }
  if (!normalizedAdditionalInfo) return next(new AppError(400, "Additional info is required."));

  const requiredFields = ["category", "sex", "bodyZone", "country"];
  for (const f of requiredFields) {
    if (!normalizedAdditionalInfo[f]) return next(new AppError(400, `additionalInfo.${f} is required.`));
  }

  const prompt = buildPrompt({
    symptoms: normalizedSymptoms,
    additionalInfo: normalizedAdditionalInfo,
    freeText: normalizedFreeText,
    language: normalizedLanguage,
  });

  let ai;
  let aiModel = HEALTH_AI_MODEL;
  let promptVersion = HEALTH_PROMPT_VERSION;

  try {
    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: HEALTH_AI_MODEL,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "health_analysis_result",
          strict: true,
          schema: HEALTH_OUTPUT_SCHEMA,
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You are a cautious medical triage assistant. Output only the requested JSON. Never diagnose. Calibrate confidence conservatively.",
        },
        { role: "user", content: prompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    ai = safeJsonParse(raw);

    if (!validateAiOutput(ai)) {
      throw new Error("AI response format mismatch.");
    }
  } catch (error) {
    const code = error?.code || error?.error?.code || error?.status;
    console.error("[HealthAI] Generation failed:", code || error?.message || error);
    return next(
      new AppError(
        503,
        "Get solution not possible right now. AI service is unavailable.",
      ),
    );
  }

  if (!validateAiOutput(ai)) {
    return next(new AppError(502, "Get solution not possible. Please try again later."));
  }

  const normalizedConditions = normalizePossibleConditions(
    ai.possibleConditions,
    normalizedSymptoms,
    normalizedLanguage,
  );
  const emergencyAlert = deriveEmergencyAlert(
    normalizedSymptoms,
    normalizedConditions,
    normalizedLanguage,
  );
  const normalizedTests = normalizeRecommendedTests(
    ai.recommendedTests,
    normalizedSymptoms,
    normalizedLanguage,
  );
  const normalizedRemedies = buildNaturalRemedies(
    ai.naturalRemedies,
    normalizedSymptoms,
    emergencyAlert,
    normalizedLanguage,
  );
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

  const normalizedRedFlags = normalizeRedFlags(
    ai.redFlags,
    normalizedSymptoms,
    normalizedLanguage,
  );
  const normalizedDisclaimer = normalizeDisclaimer(
    ai.disclaimer,
    normalizedLanguage,
  );

  const doc = await HealthSolution.create({
    user: req.user?.id, // optional if you have auth middleware
    input: {
      symptoms: normalizedSymptoms,
      additionalInfo: normalizedAdditionalInfo,
      freeText: normalizedFreeText,
    },
    output: {
      possibleConditions: normalizedConditions,
      naturalRemedies: enrichedRemedies,
      recommendedTests: normalizedTests,
      redFlags: normalizedRedFlags,
      emergencyAlert,
      disclaimer: normalizedDisclaimer,
    },
    aiMeta: {
      provider: "openai",
      model: aiModel,
      promptVersion,
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
  if (!doc) return next(new AppError(404, "Health solution not found."));

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
  if (!userId) return next(new AppError(401, "Unauthorized."));

  const docs = await HealthSolution.find({ user: userId }).sort({ createdAt: -1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Your health solutions fetched successfully.",
    data: docs,
  });
});
