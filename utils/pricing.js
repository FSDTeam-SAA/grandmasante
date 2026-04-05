export const NOTCHPAY_CURRENCY = (
  process.env.NOTCHPAY_CURRENCY || "XAF"
).toUpperCase();

export const CURRENCY_DISPLAY = NOTCHPAY_CURRENCY === "XAF"
  ? "FCFA"
  : NOTCHPAY_CURRENCY;

export const DELIVERY_COUNTRY = "Cameroon";
export const TREATMENT_CONSULTATION_FEE_CAMEROON = 500;
export const CONSULTATION_FEE_OUTSIDE_CAMEROON = 1000;
export const GRANDMA_SANTE_INTERACT_FEE = 1000;

const CAMEROON_ALIASES = new Set(["cameroon", "cameroun"]);

export const normalizeCountry = (country) => {
  if (typeof country !== "string") return "";
  return country.trim().replace(/\s+/g, " ");
};

export const isCameroonCountry = (country) => {
  const normalizedCountry = normalizeCountry(country).toLowerCase();
  return CAMEROON_ALIASES.has(normalizedCountry);
};

export const getConsultationFee = (country) =>
  isCameroonCountry(country)
    ? TREATMENT_CONSULTATION_FEE_CAMEROON
    : CONSULTATION_FEE_OUTSIDE_CAMEROON;

export const buildTreatmentPricing = ({ subtotal, country }) => {
  const consultationFee = getConsultationFee(country);
  const grandmaSanteInteractFee = GRANDMA_SANTE_INTERACT_FEE;
  const total = subtotal + consultationFee + grandmaSanteInteractFee;

  return {
    subtotal,
    consultationFee,
    grandmaSanteInteractFee,
    total,
    currency: NOTCHPAY_CURRENCY,
    currencyDisplay: CURRENCY_DISPLAY,
  };
};
