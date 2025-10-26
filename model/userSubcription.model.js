import mongoose, { Schema } from "mongoose";

const userSubscriptionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    plan: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "expired"],
      default: "active",
    },
    paymentMethod: {
      type: String,
      default: "stripe",
    },
    stripeSubscriptionId: {
      type: String,
    },
    couponUsed: {
      type: String,
    },
  },
  { timestamps: true }
);

export const UserSubscription = mongoose.model(
  "UserSubscription",
  userSubscriptionSchema
);
