// models/healthSolution.model.js
import mongoose, { Schema } from "mongoose";

const remedySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    tags: [{ type: String }], // e.g. ["1–2 cups daily", "best before bed"]
    howToUse: { type: String, required: true },
    notes: { type: String }, // optional extra info
    image: {
      publicId: { type: String },
      url: { type: String },
      thumbnailUrl: { type: String },
      source: { type: String },
      sourcePage: { type: String },
      license: { type: String },
      licenseUrl: { type: String },
      creator: { type: String },
      creatorUrl: { type: String },
      attribution: { type: String },
    },
  },
  { _id: false }
);

const testSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Complete Blood Count (CBC)"
    reason: { type: String, required: true }, // e.g. "Check for anemia/infection"
  },
  { _id: false }
);

const conditionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "Dehydration"
    confidence: { type: Number, min: 0, max: 1 }, // 0..1
    rationale: { type: String, required: true },
  },
  { _id: false }
);

const healthSolutionSchema = new mongoose.Schema(
  {
    // If you have auth, store req.user.id here
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    input: {
      symptoms: [{ type: String, required: true }],
      additionalInfo: {
        category: {
          type: String,
          enum: [
            "Infant (0-2)",
            "Child (3-12)",
            "Young Adult (13-17)",
            "Adult (18-64)",
            "Senior (65+)",
          ],
          required: true,
        },
        sex: { type: String, enum: ["Male", "Female", "Other"], required: true },
        bodyZone: {
          type: String,
          enum: ["Head", "Chest", "Abdomen", "Back", "Arms", "Legs", "Full Body"],
          required: true,
        },
        country: { type: String, required: true },
      },
      freeText: { type: String }, // optional note from user
    },

    output: {
      possibleConditions: [conditionSchema],
      naturalRemedies: [remedySchema],
      recommendedTests: [testSchema],
      disclaimer: { type: String, required: true },
      redFlags: [{ type: String }], // e.g. “chest pain + shortness of breath”
    },

    // Store model metadata for audit/debugging
    aiMeta: {
      provider: { type: String, default: "openai" },
      model: { type: String },
      promptVersion: { type: String, default: "v1" },
    },
  },
  { timestamps: true }
);

export const HealthSolution=  mongoose.model("HealthSolution", healthSolutionSchema);
