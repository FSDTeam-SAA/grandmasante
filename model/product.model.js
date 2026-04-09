import mongoose, { Schema } from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const productSchema = new Schema(
  {
    name: { type: String },
    description: { type: String, trim: true, default: "" },
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
