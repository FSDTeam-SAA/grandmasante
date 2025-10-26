import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new Schema(
  {
    name: { type: String },
    email: { type: String, unique: true },
    password: { type: String, select: 0 },
    username: { type: String },
    phone: { type: String },
    credit: { type: Number, default: null },
    dob: { type: Date },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
    },
    role: {
      type: String,
      default: "user",
      enum: ["user", "admin"],
    },
    avatar: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    enableNotifications: { type: Boolean, default: true },
    dnd: { type: Boolean, default: false },
    lastPost: { type: Date },
    totalPosts: { type: Number, default: 0 },
    address: {
      type: String,
    },
    verificationInfo: {
      verified: { type: Boolean, default: false },
      token: { type: String, default: "" },
    },
    password_reset_token: { type: String, default: "" },
    fine: { type: Number, default: 0 },
    refreshToken: { type: String, default: "" },
    localTax: { type: String },
    review: [
      {
        rating: {
          type: Number,
          min: [0, "Rating cannot be negative"],
          max: [5, "Rating cannot exceed 5"],
          default: 0,
        },
        user: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        text: {
          type: String,
        },
      },
    ],
    currentPlan: {
      type: String,
      default: "Traveler",
    },
    subscription: {
      type: Schema.Types.ObjectId,
      ref: "UserSubscription",
      default: null,
    },
    savedItems: [
      {
        type: Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    purchases: [
      {
        type: Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    totalSavings: {
      type: Number,
      default: 0,
    },
    avgSavings: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  const user = this;
  if (user.isModified("password")) {
    const saltRounds = Number(process.env.bcrypt_salt_round) || 10;
    user.password = await bcrypt.hash(user.password, saltRounds);
  }
  next();
});

userSchema.statics.isUserExistsByEmail = async function (email) {
  return await User.findOne({ email }).select("+password");
};

userSchema.statics.isOTPVerified = async function (id) {
  const user = await User.findById(id).select("+verificationInfo");
  return user?.verificationInfo.verified;
};

userSchema.statics.isPasswordMatched = async function (
  plainTextPassword,
  hashPassword
) {
  return await bcrypt.compare(plainTextPassword, hashPassword);
};

export const User = mongoose.model("User", userSchema);
