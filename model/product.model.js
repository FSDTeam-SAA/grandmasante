import mongoose, { Schema } from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

export const PRODUCT_CATEGORIES = [
  "herbal-remedies",
  "teas",
  "tinctures",
  "essential-oils",
];

const productSchema = new Schema(
  {
    name: { type: String },
    description: { type: String, trim: true, default: "" },
    category: {
      type: String,
      enum: PRODUCT_CATEGORIES,
      required: false,
      default: undefined,
    },
    image: {
      public_id: { type: String },
      url: { type: String },
    },
    totalUnit: { type: Number },
    remainingUnit: { type: Number },
    unit: { type: String, default: "pieces" },
    perPrice: { type: Number },
    addedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

productSchema.plugin(mongoosePaginate);

export const Product = mongoose.model("Product", productSchema);
