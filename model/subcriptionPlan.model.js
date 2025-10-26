import mongoose, { Schema } from "mongoose";

const subscriptionPlanSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    priceMonthly: {
      type: Number,
      required: true,
      default: 0,
    },
    priceYearly: {
      type: Number,
      required: true,
      default: 0,
    },
    benefits: [
      {
        type: String,
      },
    ],
    hasAds: {
      type: Boolean,
      default: false,
    },
    maxItems: {
      type: Number,
      default: Infinity,
    },
    maxCurrencies: {
      type: Number,
      default: Infinity,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export const SubscriptionPlan = mongoose.model(
  "SubscriptionPlan",
  subscriptionPlanSchema
);
