import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  cost: { N: number; r: number; p: number },
) => Promise<Buffer>;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export function validPasswordPolicy(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (password.includes("\u0000")) return "password contains an invalid character";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function passwordMatches(stored: string, password: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) return false;
  if (n > SCRYPT_N || r > SCRYPT_R || p > SCRYPT_P) return false;
  const saltPart = parts[4] ?? "";
  const expectedPart = parts[5] ?? "";
  const salt = Buffer.from(saltPart, "base64");
  const expected = Buffer.from(expectedPart, "base64");
  if (salt.length === 0 || expected.length === 0 || expected.length > 512) return false;
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_DEVICES = 20;

interface RememberedDevice {
  id: string;
  sidHash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
}

export function loginSessionHash(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

export interface LoginPasswordRecord {
  id: string;
  hash: string;
  initialHash: string;
  forceChange: boolean;
  failedAttempts: number;
  lockedUntil: number;
  updatedAt: number;
  updatedBy: string;
  version?: string;
  devices?: RememberedDevice[];
  lastReset?: { id: string; actor: string; at: number };
}

type VerifyOutcome =
  | { status: "ok"; forceChange: boolean; version: string }
  | { status: "invalid" }
  | { status: "locked"; retryInMs: number };

type SetOutcome = "ok" | "no-credential" | "wrong-current" | "weak-password" | "same-as-initial";

export interface LoginPasswordStore {
  get(id: string): Promise<LoginPasswordRecord | null>;
  remember(
    id: string,
    version: string,
    sid: string,
    device: Omit<RememberedDevice, "sidHash">,
  ): Promise<"ok" | "invalid" | "limit">;
  revokeDevice(id: string, version: string, deviceId: string, currentSid?: string): Promise<boolean>;
  revokeSession(id: string, sid: string): Promise<void>;
  revokeAllSessions(id: string): Promise<void>;
  putInitial(input: { id: string; initialPassword: string; updatedBy: string }): Promise<LoginPasswordRecord>;
  verify(id: string, password: string, nowMs?: number): Promise<VerifyOutcome>;
  setNew(
    id: string,
    next: string,
    current: string | null,
    nowMs?: number,
    expectedVersion?: string,
    nextVersion?: string,
  ): Promise<SetOutcome>;
  resetInitial(
    id: string,
    actor: string,
    expectedVersion: string,
    operationId: string,
  ): Promise<"ok" | "no-credential" | "conflict">;
}

export function createLoginPasswordStore(
  backing: DurableMap<LoginPasswordRecord> = createMemoryMap<LoginPasswordRecord>(),
  now: () => number = Date.now,
): LoginPasswordStore {
  const update = (id: string, fn: (record: LoginPasswordRecord) => LoginPasswordRecord) => {
    if (!backing.update) throw new Error("password store requires atomic update");
    return backing.update(id, fn);
  };
  return {
    get: (id) => backing.get(id),
    async remember(id, version, sid, device) {
      const at = now();
      if (
        !/^[a-f0-9]{64}$/.test(sid) ||
        !/^[a-f0-9-]{36}$/.test(device.id) ||
        !Number.isSafeInteger(device.createdAt) ||
        !Number.isSafeInteger(device.expiresAt) ||
        device.createdAt > at + CLOCK_SKEW_MS ||
        device.createdAt < at - 60_000 ||
        device.expiresAt <= at ||
        device.expiresAt > device.createdAt + REMEMBER_TTL_MS
      )
        return "invalid";
      let outcome: "ok" | "invalid" | "limit" = "invalid";
      await update(id, (record) => {
        if (record.forceChange || (record.version ?? "") !== version) return record;
        const devices = (record.devices ?? []).filter((entry) => entry.expiresAt > at);
        const sidHash = loginSessionHash(sid);
        const existing = devices.find((entry) => entry.sidHash === sidHash || entry.id === device.id);
        if (existing) {
          if (existing.sidHash === sidHash && existing.id === device.id && existing.expiresAt === device.expiresAt)
            outcome = "ok";
          return record;
        }
        if (devices.length >= MAX_REMEMBERED_DEVICES) {
          outcome = "limit";
          return record;
        }
        outcome = "ok";
        return {
          ...record,
          devices: [
            ...devices,
            { ...device, label: device.label.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160), sidHash },
          ],
        };
      });
      return outcome;
    },
    async revokeDevice(id, version, deviceId, currentSid) {
      let valid = false;
      await update(id, (record) => {
        if (record.forceChange || (record.version ?? "") !== version) return record;
        if (
          currentSid &&
          !(record.devices ?? []).some(
            (device) => device.sidHash === loginSessionHash(currentSid) && device.expiresAt > now(),
          )
        )
          return record;
        valid = true;
        return {
          ...record,
          devices: (record.devices ?? []).filter((device) => device.id !== deviceId && device.expiresAt > now()),
        };
      });
      return valid;
    },
    async revokeSession(id, sid) {
      const hash = loginSessionHash(sid);
      await update(id, (record) => ({
        ...record,
        devices: (record.devices ?? []).filter((device) => device.sidHash !== hash && device.expiresAt > now()),
      }));
    },
    async revokeAllSessions(id) {
      const version = randomUUID();
      await update(id, (record) => ({ ...record, version, devices: [] }));
    },
    async putInitial({ id, initialPassword, updatedBy }) {
      const policy = validPasswordPolicy(initialPassword);
      if (policy) throw new Error(policy);
      const hash = await hashPassword(initialPassword);
      const record: LoginPasswordRecord = {
        id,
        hash,
        initialHash: hash,
        version: randomUUID(),
        forceChange: true,
        failedAttempts: 0,
        lockedUntil: 0,
        updatedAt: now(),
        updatedBy,
      };
      await backing.putIfAbsent(id, record);
      await update(id, () => record);
      return record;
    },
    async verify(id, password, nowMs = now()) {
      const record = await backing.get(id);
      if (!record) return { status: "invalid" };
      if (record.lockedUntil > nowMs) return { status: "locked", retryInMs: record.lockedUntil - nowMs };
      const matches = await passwordMatches(record.hash, password);
      let outcome: VerifyOutcome = { status: "invalid" };
      await update(id, (latest) => {
        if (latest.hash !== record.hash || latest.version !== record.version) return latest;
        if (latest.lockedUntil > nowMs) {
          outcome = { status: "locked", retryInMs: latest.lockedUntil - nowMs };
          return latest;
        }
        if (matches) {
          outcome = { status: "ok", forceChange: latest.forceChange, version: latest.version ?? "" };
          return { ...latest, failedAttempts: 0, lockedUntil: 0 };
        }
        const lockExpired = latest.lockedUntil > 0 && latest.lockedUntil <= nowMs;
        const failedAttempts = (lockExpired ? 0 : latest.failedAttempts) + 1;
        const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS ? nowMs + LOCK_WINDOW_MS : latest.lockedUntil;
        if (lockedUntil > nowMs) outcome = { status: "locked", retryInMs: lockedUntil - nowMs };
        return { ...latest, failedAttempts, lockedUntil };
      });
      return outcome;
    },
    async resetInitial(id, actor, expectedVersion, operationId) {
      let outcome: "ok" | "no-credential" | "conflict" = "no-credential";
      await update(id, (record) => {
        if (!record.initialHash) return record;
        if (record.lastReset?.id === operationId) {
          outcome =
            record.lastReset.actor === actor &&
            record.version === operationId &&
            record.forceChange &&
            record.hash === record.initialHash &&
            record.failedAttempts === 0 &&
            record.lockedUntil === 0
              ? "ok"
              : "conflict";
          return record;
        }
        if ((record.version ?? "") !== expectedVersion) {
          outcome = "conflict";
          return record;
        }
        const at = now();
        outcome = "ok";
        return {
          ...record,
          hash: record.initialHash,
          forceChange: true,
          failedAttempts: 0,
          lockedUntil: 0,
          version: operationId,
          devices: [],
          updatedAt: at,
          updatedBy: actor,
          lastReset: { id: operationId, actor, at },
        };
      });
      return outcome;
    },
    async setNew(id, next, current, nowMs = now(), expectedVersion = "", nextVersion = randomUUID()) {
      const policy = validPasswordPolicy(next);
      if (policy) return "weak-password";
      const record = await backing.get(id);
      if (!record) return "no-credential";
      if (current !== null) {
        if (!(await passwordMatches(record.hash, current))) return "wrong-current";
      } else if (!record.forceChange || (record.version ?? "") !== expectedVersion) {
        return "wrong-current";
      }
      if (await passwordMatches(record.initialHash, next)) return "same-as-initial";
      const hash = await hashPassword(next);
      let outcome: SetOutcome = "wrong-current";
      await update(id, (latest) => {
        if (
          latest.hash !== record.hash ||
          latest.version !== record.version ||
          latest.forceChange !== record.forceChange
        )
          return latest;
        outcome = "ok";
        return {
          ...latest,
          hash,
          forceChange: false,
          failedAttempts: 0,
          lockedUntil: 0,
          version: nextVersion,
          devices: [],
          updatedAt: nowMs,
          updatedBy: id,
        };
      });
      return outcome;
    },
  };
}
