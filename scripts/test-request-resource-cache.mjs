import assert from "node:assert/strict";
import { RequestCoordinator } from "../src/requestCoordinator.ts";
import { WorkspaceResourceCache } from "../src/workspaceResourceCache.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

{
  const coordinator = new RequestCoordinator();
  const work = deferred();
  let calls = 0;
  const first = coordinator.run("session:a", async () => {
    calls += 1;
    return work.promise;
  });
  const second = coordinator.run("session:a", async () => {
    calls += 1;
    return "unexpected";
  });
  assert.strictEqual(first, second, "legacy run() calls should still coalesce by key");
  assert.equal(calls, 1);
  work.resolve("ready");
  assert.equal(await second, "ready");
  await Promise.resolve();
  assert.equal(coordinator.pendingCount, 0);
}

{
  const coordinator = new RequestCoordinator();
  const oldWork = deferred();
  const latestWork = deferred();
  let oldSignal;
  const oldRequest = coordinator.run("preview:file", async (signal) => {
    oldSignal = signal;
    return oldWork.promise;
  });
  const latest = coordinator.runLatest("preview:file", () => latestWork.promise);
  await assert.rejects(oldRequest, (error) => error?.name === "AbortError");
  assert.equal(oldSignal.aborted, true);
  assert.equal(coordinator.pendingCount, 1, "old cleanup must not remove the replacement request");
  oldWork.resolve("stale result is safely ignored");
  await Promise.resolve();
  assert.equal(coordinator.pendingCount, 1, "late completion must not remove the replacement request");
  latestWork.resolve("latest");
  assert.equal(await latest, "latest");
}

{
  const coordinator = new RequestCoordinator();
  const generation = coordinator.beginNavigation();
  const navigationWork = deferred();
  const backgroundWork = deferred();
  const navigation = coordinator.run("workspace:one", () => navigationWork.promise, { generation });
  const background = coordinator.run("background", () => backgroundWork.promise);

  const nextGeneration = coordinator.beginGeneration();
  assert.equal(nextGeneration, generation + 1);
  await assert.rejects(navigation, (error) => error?.name === "AbortError");
  assert.equal(coordinator.pendingCount, 1, "unbound background reads must survive navigation");

  let staleInvoked = false;
  await assert.rejects(
    coordinator.run("stale", async () => {
      staleInvoked = true;
      return "bad";
    }, { generation }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(staleInvoked, false, "stale generations must be rejected before starting work");

  assert.equal(coordinator.cancel("background", "test complete"), true);
  await assert.rejects(background, (error) => error?.name === "AbortError");
  assert.equal(coordinator.cancel("missing"), false);
  navigationWork.resolve("stale");
  backgroundWork.resolve("done");
}

{
  const coordinator = new RequestCoordinator();
  const generation = coordinator.beginNavigation();
  const navigationWork = deferred();
  let navigationSignal;
  let prefetchCalls = 0;
  const navigation = coordinator.run("session:large", (signal) => {
    navigationSignal = signal;
    return navigationWork.promise;
  }, { generation });
  const delayedPrefetch = coordinator.run("session:large", async () => {
    prefetchCalls += 1;
    return "background must not replace navigation";
  });

  assert.strictEqual(delayedPrefetch, navigation, "background prefetch must join an active foreground navigation");
  assert.equal(prefetchCalls, 0);
  assert.equal(navigationSignal.aborted, false);
  navigationWork.resolve("loaded");
  assert.equal(await delayedPrefetch, "loaded");
}

{
  let now = 1_000;
  const cache = new WorkspaceResourceCache(2, () => now);
  cache.set("a", { value: 1 });
  now = 1_200;
  cache.set("b", { value: 2 });
  assert.deepEqual(cache.peekEntry("a"), {
    value: { value: 1 },
    updatedAt: 1_000,
    ageMs: 200
  });
  assert.equal(cache.getAge("a"), 200);
  assert.equal(cache.isFresh("a", 199), false);
  assert.equal(cache.isFresh("a", 200), true);
  assert.equal(cache.isFresh("a", -1), false);

  cache.peek("a");
  cache.set("c", { value: 3 });
  assert.equal(cache.has("a"), false, "peek() must not promote an LRU entry");
  assert.equal(cache.has("b"), true);

  cache.get("b");
  cache.set("d", { value: 4 });
  assert.equal(cache.has("c"), false, "get() must promote an LRU entry");
  assert.deepEqual(cache.get("b"), { value: 2 });
  assert.equal(cache.size, 2);

  cache.setCapacity(1);
  assert.equal(cache.capacity, 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.has("b"), true);
  assert.equal(cache.delete("b"), true);
  assert.equal(cache.size, 0);
}

{
  const cache = new WorkspaceResourceCache(0);
  cache.set("never-retained", 1);
  assert.equal(cache.size, 0);
  assert.throws(() => cache.setCapacity(-1), RangeError);
}

console.log("request coordination and workspace resource cache tests passed");
