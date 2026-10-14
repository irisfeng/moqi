import assert from "node:assert/strict";
import { test } from "node:test";

function snapshot(points: number) {
  return { points, onboarding: { status: "available" } };
}

test("a delayed growth GET cannot overwrite a newer action result", async () => {
  const originalFetch = globalThis.fetch;
  let releaseGet!: (response: Response) => void;
  let getStarted!: () => void;
  const started = new Promise<void>((resolve) => (getStarted = resolve));
  const delayedGet = new Promise<Response>((resolve) => (releaseGet = resolve));
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(snapshot(30));
    getStarted();
    return delayedGet;
  }) as typeof fetch;
  try {
    const growth = await import(`../src/growth.ts?race=${Date.now()}`);
    const refresh = growth.refreshGrowthSnapshot();
    await started;
    await growth.submitGrowthAction({ action: "start", key: "onboarding-v1" });
    assert.equal(growth.currentGrowthSnapshot()?.points, 30);
    releaseGet(Response.json(snapshot(0)));
    await refresh;
    assert.equal(growth.currentGrowthSnapshot()?.points, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a GET started during an action cannot overwrite the committed action result", async () => {
  const originalFetch = globalThis.fetch;
  let releaseGet!: (response: Response) => void;
  let releasePost!: (response: Response) => void;
  let getStarted!: () => void;
  let postStarted!: () => void;
  const getGate = new Promise<Response>((resolve) => (releaseGet = resolve));
  const postGate = new Promise<Response>((resolve) => (releasePost = resolve));
  const getStartedPromise = new Promise<void>((resolve) => (getStarted = resolve));
  const postStartedPromise = new Promise<void>((resolve) => (postStarted = resolve));
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postStarted();
      return postGate;
    }
    getStarted();
    return getGate;
  }) as typeof fetch;
  try {
    const growth = await import(`../src/growth.ts?race-during-action=${Date.now()}`);
    const action = growth.submitGrowthAction({ action: "start", key: "onboarding-v1" });
    await postStartedPromise;
    const refresh = growth.refreshGrowthSnapshot();
    await getStartedPromise;
    releasePost(Response.json(snapshot(30)));
    await action;
    assert.equal(growth.currentGrowthSnapshot()?.points, 30);
    releaseGet(Response.json(snapshot(0)));
    await refresh;
    assert.equal(growth.currentGrowthSnapshot()?.points, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("growth actions are serialized so the last committed response stays authoritative", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFirst!: (response: Response) => void;
  let releaseSecond!: (response: Response) => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  let postCount = 0;
  const firstGate = new Promise<Response>((resolve) => (releaseFirst = resolve));
  const secondGate = new Promise<Response>((resolve) => (releaseSecond = resolve));
  const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
  const secondStartedPromise = new Promise<void>((resolve) => (secondStarted = resolve));
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(snapshot(0));
    postCount += 1;
    if (postCount === 1) {
      firstStarted();
      return firstGate;
    }
    secondStarted();
    return secondGate;
  }) as typeof fetch;
  try {
    const growth = await import(`../src/growth.ts?serialized-actions=${Date.now()}`);
    const first = growth.submitGrowthAction({ action: "accept", key: "daily-v1", runId: "run-b" });
    const second = growth.submitGrowthAction({ action: "accept", key: "daily-v1", runId: "run-a" });
    await firstStartedPromise;
    assert.equal(postCount, 1);
    releaseFirst(Response.json(snapshot(20)));
    await secondStartedPromise;
    assert.equal(postCount, 2);
    releaseSecond(Response.json(snapshot(30)));
    await Promise.all([first, second]);
    assert.equal(growth.currentGrowthSnapshot()?.points, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a response that is not a growth snapshot is never published", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ contexts: [], items: [] })) as typeof fetch;
  try {
    const growth = await import(`../src/growth.ts?malformed=${Date.now()}`);
    await assert.rejects(growth.refreshGrowthSnapshot());
    assert.equal(growth.currentGrowthSnapshot(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
