import assert from "node:assert/strict";
import {
  initTheme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

initTheme("dark");

export type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
export type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
export type TestComponent = ReturnType<typeof mountComponent>;

export function mountComponent(
  factory: CustomFactory,
  done: (value: unknown) => void = () => {},
  options: {
    terminal?: { rows: number; columns: number };
    theme?: Partial<Parameters<CustomFactory>[1]>;
  } = {},
) {
  const component = factory(
    {
      requestRender() {},
      terminal: options.terminal ?? { rows: 42, columns: 120 },
    } as Parameters<CustomFactory>[0],
    {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      getBgAnsi: () => "",
      ...options.theme,
    } as Parameters<CustomFactory>[1],
    {} as Parameters<CustomFactory>[2],
    done,
  );
  assert.ok(!(component instanceof Promise));
  assert.ok(component.handleInput);
  return component as typeof component & { handleInput(data: string): void };
}

export function customUI(
  run: (factory: CustomFactory, options: CustomOptions) => Promise<unknown>,
): ExtensionUIContext["custom"] {
  return run as ExtensionUIContext["custom"];
}
