const messages: Record<string, string> = {
  "session busy (another turn is in progress)": "The conversation is busy with your last message. Wait and try again.",
  "project membership changed; retry from the current project": "Project access changed. Refresh and try again.",
  "internal-only: non-internal principals cannot interact": "This feature is for internal members only.",
  "internal-only: shared audience includes a non-internal participant": "Not available: external members are present.",
  "Failed to fetch": "Network connection failed. Check your network and try again.",
  "fetch failed": "Could not reach the service. Try again later.",
  "Load failed": "Network loading failed. Check your network and try again.",
  "NetworkError when attempting to fetch resource.": "Network connection failed. Check your network and try again.",
  "Connection error.": "Could not reach the model service. Try again later.",
  "Request timed out.": "The request timed out. Try again later.",
  aborted: "The action was cancelled.",
  bad_request: "The request is invalid. Check it and try again.",
  bad_core_response: "The service returned an error. Try again later.",
  bad_gateway: "The service connection failed. Try again later.",
  "empty message": "The message cannot be empty. Enter something and send it.",
  forbidden_scope: "You do not have access to this scope. Contact an administrator.",
  forbidden_thread: "You do not have access to this conversation. Contact an administrator.",
  not_allowed: "Your account cannot use this feature. Contact an administrator.",
  payload_too_large: "The upload is too large. Use a smaller file or upload in batches.",
  "sign in": "Sign in first, then try again.",
  not_configured: "This feature is not configured. Contact an administrator.",
  upstream_error: "The upstream service is having a problem. Try again later.",
  invalid_destination: "The destination is invalid. Choose another.",
  invalid_filters: "The filters are invalid. Check them and try again.",
  unauthenticated: "Your sign-in has expired. Sign in again.",
  unauthorized: "Authentication failed. Sign in again.",
  forbidden: "You do not have permission to do this. Contact an administrator.",
  not_found: "This content does not exist or is no longer accessible. Refresh and try again.",
  "not found": "This content does not exist or is no longer accessible. Refresh and try again.",
  "internal server error": "The service is having a problem. Try again later.",
};

const httpMessages: Record<number, string> = {
  400: "The request is invalid. Check it and try again.",
  401: "Your sign-in has expired. Sign in again.",
  403: "You do not have permission to do this. Contact an administrator.",
  404: "This content does not exist or is no longer accessible. Refresh and try again.",
  408: "The request timed out. Try again later.",
  409: "The action conflicts with the current state. Refresh and try again.",
  413: "The upload is too large. Use a smaller file or upload in batches.",
  429: "Too many requests. Try again later.",
  500: "The service is having a problem. Try again later.",
  502: "The service connection failed. Try again later.",
  503: "The service is temporarily unavailable. Try again later.",
  504: "The service timed out. Try again later.",
};

const budgetReferenceRate = { cnyPerUsd: 67804n, decimalPlaces: 4, asOf: "2026-09-08" };

function referenceCny(usd: string): string | undefined {
  if (usd.length > 32) return undefined;
  const [whole, fraction = ""] = usd.split(".");
  const denominator = 10n ** BigInt(fraction.length + budgetReferenceRate.decimalPlaces - 2);
  const numerator = BigInt(whole + fraction) * budgetReferenceRate.cnyPerUsd;
  const cents = (numerator + denominator / 2n) / denominator;
  if (numerator > 0n && cents === 0n) return "<¥0.01";
  return `¥${(cents / 100n).toLocaleString("zh-CN")}.${String(cents % 100n).padStart(2, "0")}`;
}

export function userErrorMessage(error: unknown, fallback?: string): string {
  let original: string;
  if (error instanceof Error) original = error.message;
  else if (typeof error === "string") original = error;
  else original = fallback ?? String(error);
  const message = original.trim();
  const budget = /^budget exceeded \(\$(\d+(?:\.\d+)?) of \$(\d+(?:\.\d+)?)\); try again later$/.exec(message);
  if (budget) {
    const spent = referenceCny(budget[1]);
    const limit = referenceCny(budget[2]);
    if (spent && limit) {
      return `AI usage limit reached (about ${spent} used, limit about ${limit}). Usage is counted over a rolling 24 hours and recovers as earlier usage leaves the window. To raise the limit, contact an administrator.`;
    }
  }
  const rate = /^rate limit exceeded — try again in (\d+)s$/.exec(message);
  if (rate) return `Too many requests. Try again in ${rate[1]} seconds.`;
  if (Object.hasOwn(messages, message)) return messages[message];
  if (Object.hasOwn(messages, message.toLowerCase())) return messages[message.toLowerCase()];
  const http = /^(?:attachment upload failed: )?HTTP (\d{3})$/.exec(message);
  if (http) {
    const text = httpMessages[Number(http[1])] ?? "The request failed. Try again later.";
    return `${message.startsWith("attachment") ? "Attachment upload failed: " : ""}${text} (HTTP ${http[1]})`;
  }
  return original;
}
