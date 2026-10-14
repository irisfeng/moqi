export interface MessageLocation {
  deliveryId?: string;
  runId?: string;
  seq?: number;
}

export function messageLocation(value: unknown): string {
  const message = value as MessageLocation | null;
  if (typeof message?.deliveryId === "string" && message.deliveryId) return `delivery:${message.deliveryId}`;
  if (typeof message?.runId === "string" && message.runId) return `run:${message.runId}`;
  if (Number.isSafeInteger(message?.seq) && message!.seq! >= 0) return `seq:${message!.seq}`;
  return "";
}

export function readMessageLocation(value: unknown): MessageLocation {
  if (!value || typeof value !== "object") return {};
  const source = value as MessageLocation;
  const target: MessageLocation = {};
  for (const key of ["deliveryId", "runId"] as const) {
    const id = source[key];
    if (typeof id === "string" && id.length > 0 && id.length <= 200) target[key] = id;
  }
  if (Number.isSafeInteger(source.seq) && source.seq! >= 0) target.seq = source.seq;
  return target;
}
