import mongoose, { Schema } from "mongoose";

const paymentInfoSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    planId: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    discount: {
      type: Number,
      default: 0,
    },
    finalPrice: {
      type: Number,
      required: true,
    },
    transactionId: {
      type: String,
      required: true,
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
