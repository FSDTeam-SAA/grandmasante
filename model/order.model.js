import mongoose, { Schema } from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const orderSchema = new Schema(
  {
    orderId: { type: String, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    products: [
      {
        product: { type: Schema.Types.ObjectId, ref: "Product" },
        quantity: { type: Number, min: 1 },
      },
    ],
    subtotal: { type: Number, default: 0 },
    consultationFee: { type: Number, default: 0 },
    grandmaSanteInteractFee: { type: Number, default: 0 },
    total: { type: Number },
    currency: { type: String, default: "XAF" },
    deliveryCountry: { type: String },
    deliveryCoordinates: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
    status: {
      type: String,
      enum: ["ongoing", "completed", "delivered"],
      default: "ongoing",
    },
    payment: {
      transactionId: { type: String },
      status: { type: String, enum: ["pending", "paid"], default: "pending" },
    },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

orderSchema.pre("save", function (next) {
  if (!this.orderId) {
    this.orderId = `ORD${Date.now()}`;
  }
  next();
});

orderSchema.plugin(mongoosePaginate);

export const Order = mongoose.model("Order", orderSchema);
