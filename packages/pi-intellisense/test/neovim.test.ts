import test from "node:test";
import assert from "node:assert/strict";
import { openInNeovim } from "../src/neovim.ts";
import type { NeovimRpc } from "../src/neovim-rpc.ts";
import type { NeovimLocation } from "../src/neovim.ts";
import { deferred, array } from "./helpers.ts";

function fakeRpc({ failure }: { failure?: Error } = {}) {
  const calls: Array<{
    method: string;
    params: Parameters<NeovimRpc["request"]>[1];
  }> = [];
  return {
    calls,
    async request(method: string, params: Parameters<NeovimRpc["request"]>[1]) {
      calls.push({ method, params });
      if (failure) throw failure;
      return true;
    },
  };
}
const fs = {
  async readFile(path: string) {
    if (path === "/project/src/é | evil.ts") return "é🙂symbol\nmore\n";
    return "zero\nfunction target() {}\n";
  },
};
const socket = "/tmp/nvim-listen.sock";
const location: NeovimLocation = {
  path: "/project/src/a.ts",
  line: 1,
  character: 9,
  encoding: "utf-16",
};

test("NV-01: open calls Neovim RPC with a constant Lua chunk and separate pathname parameter", async () => {
  const rpc = fakeRpc();
  await openInNeovim({ location, socket, rpc, fs });
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].method, "nvim_exec_lua");
  const [chunk, args] = rpc.calls[0].params!;
  assert.equal(typeof chunk, "string");
  assert.ok(typeof chunk === "string" && Array.isArray(args));
  assert.equal(typeof chunk, "string");
  assert.ok(Array.isArray(args));
  assert.ok(args.includes("/project/src/a.ts"));
  assert.ok(!chunk.includes("/project/src/a.ts"));
  assert.ok(args.includes(2)); // LSP line 1 -> Nvim line 2.
});

test("NV-02: path containing Ex separators is never interpolated into Lua or shell", async () => {
  const rpc = fakeRpc();
  const malicious = "/project/src/é | evil.ts";
  await openInNeovim({
    location: { path: malicious, line: 0, character: 3, encoding: "utf-16" },
    socket,
    rpc,
    fs,
  });
  const [chunk, args] = rpc.calls[0].params!;
  assert.equal(typeof chunk, "string");
  assert.ok(typeof chunk === "string" && Array.isArray(args));
  assert.ok(args.includes(malicious));
  assert.ok(!chunk.includes(malicious));
  assert.equal(rpc.calls.length, 1);
});

test("NV-03: unicode prefix converts UTF-16 to exact Nvim byte column", async () => {
  const rpc = fakeRpc();
  const result = await openInNeovim({
    location: {
      path: "/project/src/é | evil.ts",
      line: 0,
      character: 3,
      encoding: "utf-16",
    },
    socket,
    rpc,
    fs,
  });
  assert.equal(result?.column, 6); // é two bytes, 🙂 four bytes.
  assert.ok(array(rpc.calls[0].params![1]).includes(6));
});

test("NV-04: absent socket is explicit error, never a request to start new Neovim", async () => {
  const rpc = fakeRpc();
  await assert.rejects(
    () => openInNeovim({ location, socket: undefined, rpc, fs }),
    /socket|server|Neovim/i,
  );
  assert.equal(rpc.calls.length, 0);
});

test("NV-05: RPC connection errors propagate and do not trigger a second attempt via a shell", async () => {
  const rpc = fakeRpc({ failure: new Error("ECONNREFUSED") });
  await assert.rejects(
    () => openInNeovim({ location, socket, rpc, fs }),
    /ECONNREFUSED/,
  );
  assert.equal(rpc.calls.length, 1);
});

test("NV-06: invalid character position cannot direct Neovim to unintended column", async () => {
  const rpc = fakeRpc();
  await assert.rejects(
    () =>
      openInNeovim({
        location: {
          path: "/project/src/a.ts",
          line: 1,
          character: 999,
          encoding: "utf-16",
        },
        socket,
        rpc,
        fs,
      }),
    /invalid|range|column/i,
  );
  assert.equal(rpc.calls.length, 0);
});

for (const cancellation of ["abort", "stale"]) {
  test(`NV: ${cancellation} during file read prevents RPC`, async () => {
    const rpc = fakeRpc();
    const controller = new AbortController();
    let current = true;
    const entered = deferred(),
      read = deferred<string>();
    const reading = entered.promise;
    const pending = openInNeovim({
      location,
      socket,
      rpc,
      signal: controller.signal,
      isCurrent: () => current,
      fs: { readFile: () => (entered.resolve(), read.promise) },
    });
    await reading;
    if (cancellation === "abort") controller.abort();
    else current = false;
    read.resolve("zero\nfunction target() {}\n");
    assert.equal(await pending, undefined);
    assert.equal(rpc.calls.length, 0);
  });
}

test("NV: cancelled or stale calls do not read files", async () => {
  const rpc = fakeRpc();
  const controller = new AbortController();
  controller.abort();
  const unread = {
    readFile() {
      assert.fail("unexpected read");
    },
  };
  assert.equal(
    await openInNeovim({
      location,
      socket,
      rpc,
      fs: unread,
      signal: controller.signal,
    }),
    undefined,
  );
  assert.equal(
    await openInNeovim({
      location,
      socket,
      rpc,
      fs: unread,
      isCurrent: () => false,
    }),
    undefined,
  );
  assert.equal(rpc.calls.length, 0);
});

test("NV: currentness is checked immediately before RPC, after computing the position", async () => {
  const rpc = fakeRpc();
  let current = true;
  const destination = {
    ...location,
    get character() {
      current = false;
      return 9;
    },
  };
  assert.equal(
    await openInNeovim({
      location: destination,
      socket,
      rpc,
      fs,
      isCurrent: () => current,
    }),
    undefined,
  );
  assert.equal(rpc.calls.length, 0);
});

for (const cancellation of ["stale", "abort"]) {
  test(`NV: awaits final async currentness and rechecks signal (${cancellation})`, async () => {
    const rpc = fakeRpc();
    const controller = new AbortController();
    let checks = 0;
    const entered = deferred(),
      check = deferred<boolean>();
    const checking = entered.promise;
    const pending = openInNeovim({
      location,
      socket,
      rpc,
      fs,
      signal: controller.signal,
      async isCurrent() {
        if (++checks < 3) return true;
        entered.resolve();
        return check.promise;
      },
    });
    await checking;
    assert.equal(rpc.calls.length, 0);
    if (cancellation === "abort") controller.abort();
    check.resolve(cancellation === "abort");
    assert.equal(await pending, undefined);
    assert.equal(rpc.calls.length, 0);
  });
}
