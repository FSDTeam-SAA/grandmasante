import mongoose, { Schema } from "mongoose";

const paymentInfoSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    planId: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
    },
    price: {
      type: Number,
    },
    discount: {
      type: Number,
      default: 0,
    },
    finalPrice: {
      type: Number,
    },
    consultationFee: {
      type: Number,
      default: 0,
    },
    grandmaSanteInteractFee: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: "XAF",
    },
    transactionId: {
      type: String,
    },
    providerTransactionId: {
      type: String,
    },
    gatewayReference: {
      type: String,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "complete", "failed"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
    },
    couponUsed: {
      type: String,
    },
    isYearly: {
      type: Boolean,
      default: false,
    },
    type: {
      type: String,
      default: "subscription",
    },
  },
  { timestamps: true }
);

export const PaymentInfo = mongoose.model("PaymentInfo", paymentInfoSchema);
