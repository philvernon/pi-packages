export interface Cursor {
  row: number;
  col: number;
}
export interface Snapshot {
  version: number;
  sessionId: string;
  itemSemanticKey: string;
  itemKind: string;
  transcriptRevision: string;
  layoutRevision: string;
  sourceText?: string;
  toolCallId?: string;
  renderedLines: string[];
  renderedStartRow: number;
  isCurrent?: () => boolean;
  isNavigationCurrent?: () => boolean;
  withNavigationPicker?: <T>(run: () => Promise<T>) => Promise<T>;
  visualCursor: Cursor | null;
  screenCursor?: Cursor;
}
export const INTELLISENSE_ACTIONS = [
  "hover",
  "definition",
  "references",
  "declaration",
  "implementation",
  "typeDefinition",
] as const;
export type IntelliSenseAction = (typeof INTELLISENSE_ACTIONS)[number];
export interface IntelliSenseRegistration {
  sessionId: string;
  extensionId: "pi-intellisense";
  actions: IntelliSenseAction[];
  invoke(operation: unknown, snapshot: unknown): Promise<unknown>;
}
export interface BridgeEvents {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isCursor(value: unknown): value is Cursor {
  return (
    isRecord(value) &&
    Number.isInteger(value.row) &&
    Number.isInteger(value.col)
  );
}
function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    typeof value.itemSemanticKey === "string" &&
    typeof value.itemKind === "string" &&
    typeof value.transcriptRevision === "string" &&
    typeof value.layoutRevision === "string" &&
    Array.isArray(value.renderedLines) &&
    value.renderedLines.every((line) => typeof line === "string") &&
    Number.isInteger(value.renderedStartRow) &&
    isCursor(value.visualCursor) &&
    (value.screenCursor === undefined || isCursor(value.screenCursor)) &&
    (value.sourceText === undefined || typeof value.sourceText === "string") &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (value.isCurrent === undefined || typeof value.isCurrent === "function") &&
    (value.isNavigationCurrent === undefined ||
      typeof value.isNavigationCurrent === "function") &&
    (value.withNavigationPicker === undefined ||
      typeof value.withNavigationPicker === "function")
  );
}
export function registerTabFocusIntelliSense({
  events,
  sessionId,
  onAction,
}: {
  events: BridgeEvents;
  sessionId: string;
  onAction: (
    operation: IntelliSenseAction,
    snapshot: Snapshot,
  ) => Promise<unknown>;
}) {
  let disposed = false,
    seenEpoch: string | undefined;
  const invoke = async (operation: unknown, snapshot: unknown) => {
    if (disposed) throw new Error("IntelliSense session disposed");
    if (!isSnapshot(snapshot) || snapshot.sessionId !== sessionId)
      throw new Error("Invalid or stale IntelliSense session snapshot");
    const action = INTELLISENSE_ACTIONS.find((action) => action === operation);
    if (!action) throw new Error("Unsupported IntelliSense action");
    return onAction(action, snapshot);
  };
  const register = () =>
    events.emit("pi-intellisense:register:v1", {
      sessionId,
      extensionId: "pi-intellisense",
      actions: [...INTELLISENSE_ACTIONS],
      invoke,
    } satisfies IntelliSenseRegistration);
  const unsubscribe = events.on("pi-tab-focus:availability:v1", (payload) => {
    if (disposed || !isRecord(payload) || payload.sessionId !== sessionId)
      return;
    const epoch =
      String(payload.bridgeVersion ?? 1) +
      ":" +
      String(payload.epoch ?? "first");
    if (epoch === seenEpoch) return;
    seenEpoch = epoch;
    register();
  });
  register();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      events.emit("pi-intellisense:unregister:v1", {
        sessionId,
        extensionId: "pi-intellisense",
      });
    },
  };
}
