import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTabFocusIntelliSense,
  type BridgeEvents,
  type IntelliSenseAction,
  type IntelliSenseRegistration,
  type Snapshot,
} from "../src/bridge/register.ts";

function bus() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    on(name, callback) {
      const list = handlers.get(name) ?? new Set();
      list.add(callback);
      handlers.set(name, list);
      return () => {
        list.delete(callback);
      };
    },
    emit(name, payload) {
      events.push({ name, payload });
      for (const callback of handlers.get(name) ?? []) callback(payload);
    },
  } satisfies BridgeEvents & { events: typeof events };
}

function registration(
  events: ReturnType<typeof bus>,
): IntelliSenseRegistration {
  const payload = events.events.find(
    (event) => event.name === "pi-intellisense:register:v1",
  )?.payload;
  assert.ok(payload && typeof payload === "object");
  assert.ok("invoke" in payload && typeof payload.invoke === "function");
  return payload as IntelliSenseRegistration;
}

const snapshot = Object.freeze<Snapshot>({
  version: 1,
  sessionId: "session-1",
  itemSemanticKey: "message:1",
  itemKind: "message",
  transcriptRevision: "5",
  layoutRevision: "80",
  visualCursor: Object.freeze({ row: 12, col: 6 }),
  renderedStartRow: 10,
  renderedLines: ["const answer = 42;"],
});

test("extension registers with pi-tab-focus using versioned event contract", async () => {
  const events = bus();
  const seen: Array<[IntelliSenseAction, Snapshot]> = [];
  const handle = registerTabFocusIntelliSense({
    events,
    sessionId: "session-1",
    onAction: async (operation, point) => seen.push([operation, point]),
  });
  const binding = registration(events);
  assert.equal(binding.sessionId, "session-1");
  assert.equal(typeof binding.invoke, "function");
  assert.deepEqual(binding.actions, [
    "hover",
    "definition",
    "references",
    "declaration",
    "implementation",
    "typeDefinition",
  ]);
  await binding.invoke("hover", snapshot);
  assert.deepEqual(seen, [["hover", snapshot]]);
  handle.dispose();
});

test("bridge availability/reload does not install duplicate consumers", async () => {
  const events = bus();
  const seen: IntelliSenseAction[] = [];
  const handle = registerTabFocusIntelliSense({
    events,
    sessionId: "session-1",
    onAction: async (operation) => seen.push(operation),
  });
  events.emit("pi-tab-focus:availability:v1", {
    sessionId: "session-1",
    available: true,
  });
  events.emit("pi-tab-focus:availability:v1", {
    sessionId: "session-1",
    available: true,
  });
  const count = events.events.filter(
    (event) => event.name === "pi-intellisense:register:v1",
  ).length;
  assert.ok(count >= 1);
  assert.ok(
    count <= 2,
    "at most one initial binding and one replacement after availability",
  );
  handle.dispose();
});

test("unregister on shutdown; callbacks cannot outlive session", async () => {
  const events = bus();
  const actions: IntelliSenseAction[] = [];
  const handle = registerTabFocusIntelliSense({
    events,
    sessionId: "session-1",
    onAction: async (operation) => actions.push(operation),
  });
  const binding = registration(events);
  handle.dispose();
  assert.equal(events.events.at(-1)?.name, "pi-intellisense:unregister:v1");
  await assert.rejects(
    binding.invoke("hover", snapshot),
    /disposed|session|unregistered/i,
  );
  assert.equal(actions.length, 0);
});

test("reject stale or invalid transcript cursors at extension boundary", async () => {
  const events = bus();
  const handle = registerTabFocusIntelliSense({
    events,
    sessionId: "session-1",
    onAction: async () => {},
  });
  const { invoke } = registration(events);
  for (const changes of [
    { sessionId: "other-session" },
    { version: 99 },
    { visualCursor: null },
    { renderedLines: "not an array" },
    { renderedLines: ["valid", 42] },
    { screenCursor: { row: 1, col: "2" } },
    { sourceText: 42 },
    { toolCallId: 42 },
    { isCurrent: true },
    { isNavigationCurrent: "not a callback" },
    { withNavigationPicker: {} },
  ]) {
    await assert.rejects(
      invoke("hover", { ...snapshot, ...changes }),
      /Invalid or stale/,
    );
  }
  handle.dispose();
});

test("reject unsupported actions without invoking the consumer", async () => {
  const events = bus();
  const handle = registerTabFocusIntelliSense({
    events,
    sessionId: "session-1",
    onAction: async () => assert.fail("unsupported action reached consumer"),
  });
  for (const action of ["rename", "completion", null, 42]) {
    await assert.rejects(
      registration(events).invoke(action, snapshot),
      /Unsupported IntelliSense action/,
    );
  }
  handle.dispose();
});
