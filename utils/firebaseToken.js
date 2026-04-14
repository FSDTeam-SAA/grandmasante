import httpStatus from "http-status";
import { createRemoteJWKSet, jwtVerify } from "jose";
import AppError from "../errors/AppError.js";

const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "grandma-sante";
const firebaseIssuer = `https://securetoken.google.com/${firebaseProjectId}`;
const googleSecureTokenJwks = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

export const verifyFirebaseIdToken = async (idToken) => {
  if (!idToken) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Google ID token is required");
  }

  try {
    const { payload } = await jwtVerify(idToken, googleSecureTokenJwks, {
      issuer: firebaseIssuer,
      audience: firebaseProjectId,
    });
    return payload;
  } catch (error) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Invalid or expired Google token",
    );
  }
};

