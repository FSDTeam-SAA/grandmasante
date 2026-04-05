import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";
import mongoosePaginate from "mongoose-paginate-v2";

const userSchema = new Schema(
  {
    name: { type: String },
    email: { type: String, unique: true },
    password: { type: String, select: 0 },
    username: { type: String },
    phone: { type: String },
    country: { type: String },
    credit: { type: Number, default: 0 },
    dob: { type: Date },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
    },
    role: {
      type: String,
      default: "user",
      enum: ["user", "commercial", "in_house", "admin"],
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "accepted",
    },
    avatar: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    address: {
      type: String,
    },
    verificationInfo: {
      verified: { type: Boolean, default: false },
      token: { type: String, default: "" },
    },
    password_reset_token: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
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
    },
    subscription: {
      type: Schema.Types.ObjectId,
      ref: "UserSubscription",
      default: null,
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
  if (user.role !== "admin") {
    if (user.role === "commercial" || user.role === "in_house") {
      user.status = "pending";
    } else {
      user.status = "accepted";
    }
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

userSchema.plugin(mongoosePaginate);

export const User = mongoose.model("User", userSchema);
