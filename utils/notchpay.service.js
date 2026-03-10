import axios from "axios";

const API_BASE_URL = process.env.NOTCHPAY_API_BASE_URL || "https://api.notchpay.co";
const PUBLIC_KEY = process.env.NOTCHPAY_PUBLIC_KEY || "";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const cleanObject = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        !(typeof value === "string" && value.trim() === "")
    )
  );

const getAuthHeaders = () => {
  if (!PUBLIC_KEY) {
    throw new Error("NOTCHPAY_PUBLIC_KEY is not configured");
  }

  return [PUBLIC_KEY, `Bearer ${PUBLIC_KEY}`];
};

const requestWithAuthFallback = async (config) => {
  const authHeaders = getAuthHeaders();
  let lastError;

  for (let i = 0; i < authHeaders.length; i++) {
    try {
      const response = await axios({
        timeout: 15000,
        baseURL: API_BASE_URL,
        ...config,
        headers: {
          "Content-Type": "application/json",
          ...(config?.headers || {}),
          Authorization: authHeaders[i],
        },
      });

      return response.data;
    } catch (error) {
      lastError = error;
      const statusCode = error?.response?.status;
      if (statusCode !== 401 || i === authHeaders.length - 1) {
        break;
      }
    }
  }

  const errorMessage =
    lastError?.response?.data?.message ||
    lastError?.response?.data?.error ||
    lastError?.message ||
    "NotchPay request failed";
  const statusCode = lastError?.response?.status || 500;
  const requestError = new Error(errorMessage);
  requestError.statusCode = statusCode;
  throw requestError;
};

export const amountToMinorUnit = (amount, currency = "XAF") => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Amount must be a positive number");
  }

  const upperCurrency = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upperCurrency)) {
    return Math.round(numericAmount);
  }

  return Math.round(numericAmount * 100);
};

export const getNotchPayTransaction = (payload) =>
  payload?.transaction ||
  payload?.payment ||
  payload?.data?.transaction ||
  payload?.data?.payment ||
  null;

export const getNotchPayStatus = (payload) => {
  const transaction = getNotchPayTransaction(payload);
  return (
    transaction?.status ||
    payload?.status ||
    payload?.data?.status ||
    null
  );
};

export const isNotchPayFailureStatus = (status = "") =>
  ["failed", "canceled", "rejected", "abandoned", "expired", "refunded"].includes(
    String(status).toLowerCase()
  );

export const createNotchPayPaymentLink = async ({
  amount,
  currency,
  reference,
  callback,
  description,
  customer,
  metadata,
}) => {
  const payload = cleanObject({
    amount,
    currency,
    reference,
    callback,
    description,
    customer: customer ? cleanObject(customer) : undefined,
    metadata,
  });

  const response = await requestWithAuthFallback({
    method: "POST",
    url: "/payments",
    data: payload,
  });

  const authorizationUrl =
    response?.authorization_url ||
    response?.data?.authorization_url ||
    null;

  if (!authorizationUrl) {
    const error = new Error("NotchPay did not return an authorization URL");
    error.statusCode = 502;
    throw error;
  }

  return {
    authorizationUrl,
    response,
    transaction: getNotchPayTransaction(response),
  };
};

export const retrieveNotchPayPayment = async (reference) => {
  if (!reference) {
    throw new Error("Payment reference is required");
  }

  return requestWithAuthFallback({
    method: "GET",
    url: `/payments/${encodeURIComponent(reference)}`,
  });
};

export const retrieveNotchPayPaymentByReferences = async (references = []) => {
  const uniqueReferences = [...new Set(references.filter(Boolean))];
  let lastError = null;

  for (const ref of uniqueReferences) {
    try {
      const response = await retrieveNotchPayPayment(ref);
      return { response, matchedReference: ref };
    } catch (error) {
      lastError = error;
      if (error?.statusCode === 404) {
        continue;
      }
      throw error;
    }
  }

  const error = new Error(lastError?.message || "Payment Not Found");
  error.statusCode = lastError?.statusCode || 404;
  throw error;
};
