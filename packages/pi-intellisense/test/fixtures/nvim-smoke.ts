import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { createNeovimNavigator } from "../../src/neovim-launcher.ts";
import { connectNeovim } from "../../src/neovim-rpc.ts";

const [resultFile, sourceFile] = process.argv.slice(2);
let socket,
  launches = 0;
const execFile = promisify(callback);
try {
  const navigator = createNeovimNavigator({
    cwd: process.cwd(),
    execFile: async (command, args, options) => {
      if (args[0] === "split-window") {
        launches++;
        socket = args.at(-1);
        const index = args.indexOf("nvim");
        args = [
          ...args.slice(0, index + 1),
          "--clean",
          "-n",
          ...args.slice(index + 1),
        ];
      }
      return execFile(command, args, options);
    },
  });
  const first = await navigator.open({
    path: sourceFile,
    line: 1,
    character: 18,
    encoding: "utf-16",
  });
  let rpc = await connectNeovim(socket),
    firstCursor;
  try {
    firstCursor = await rpc.request("nvim_win_get_cursor", [0]);
  } finally {
    rpc.close();
  }
  const second = await navigator.open({
    path: sourceFile,
    line: 0,
    character: 6,
    encoding: "utf-16",
  });
  rpc = await connectNeovim(socket);
  let file, cursor;
  try {
    file = await rpc.request("nvim_buf_get_name", [0]);
    cursor = await rpc.request("nvim_win_get_cursor", [0]);
  } finally {
    rpc.close();
  }
  await writeFile(
    resultFile,
    JSON.stringify({
      launches,
      first,
      firstCursor,
      second,
      file,
      cursor,
      socket,
    }),
  );
} catch (error) {
  await writeFile(
    resultFile,
    JSON.stringify({
      error: error instanceof Error ? error.stack : String(error),
      socket,
    }),
  );
  process.exitCode = 1;
}
