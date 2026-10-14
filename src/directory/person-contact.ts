export interface PersonContact {
  phone: string;
}

const PHONE_CHARACTERS = /^[0-9+\-() 转]+$/u;
const PHONE_MAX_LENGTH = 32;
const PHONE_MIN_DIGITS = 3;

export function contactEmail(principalId: string): string | null {
  return principalId.includes("@") ? principalId : null;
}

export function parsePhone(value: unknown): { phone: string | null } | null {
  if (value === null) return { phone: null };
  if (typeof value !== "string") return null;
  const phone = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!phone) return { phone: null };
  const digits = phone.replace(/\D/g, "").length;
  return phone.length <= PHONE_MAX_LENGTH && PHONE_CHARACTERS.test(phone) && digits >= PHONE_MIN_DIGITS
    ? { phone }
    : null;
}
