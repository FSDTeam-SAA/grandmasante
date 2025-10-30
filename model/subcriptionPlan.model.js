import mongoose, { Schema } from "mongoose";

const subscriptionPlanSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      enum: ["Basic", "Premium", "Extreme"],
    },
    priceMonthly: {
      type: Number,
      required: true,
    },
    priceYearly: {
      type: Number,
      required: true,
    },
    credits: {
      type: Number,
      required: true,
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
