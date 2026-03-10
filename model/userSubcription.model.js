import mongoose from "mongoose";

const userSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    creditsRemaining: { type: Number, required: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    paymentMethod: { type: String, default: "notchpay" },
    gatewayTransactionId: { type: String },
    notchpayTransactionId: { type: String },
    stripeTransactionId: { type: String },
    startDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const UserSubscription = mongoose.model(
  "UserSubscription",
  userSubscriptionSchema
);
