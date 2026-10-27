const workspaceAliases = process.argv.includes("--workspace-aliases");
const flatSymbols = process.argv.includes("--flat-symbols");
const failedMethod = process.argv
  .find((arg) => arg.startsWith("--fail-method="))
  ?.split("=")[1];
const failedFile = process.argv
  .find((arg) => arg.startsWith("--fail-file="))
  ?.split("=")[1];
let buffer = Buffer.alloc(0),
  documentUri: string | undefined;
function send(
  msg: { id: string | number } & (
    { result: unknown } | { error: { code: number; message: string } }
  ),
) {
  const json = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  process.stdout.write("Content-Length: " + json.length + "\r\n\r\n");
  process.stdout.write(json);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(
      buffer.subarray(0, end).toString(),
    );
    if (!m) process.exit(2);
    const length = Number(m[1]);
    if (buffer.length < end + 4 + length) break;
    const msg = JSON.parse(
      buffer.subarray(end + 4, end + 4 + length).toString(),
    );
    buffer = buffer.subarray(end + 4 + length);
    if (msg.method === "initialize")
      send({
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            workspaceSymbolProvider: true,
            documentSymbolProvider: true,
            positionEncoding: "utf-16",
          },
        },
      });
    else if (msg.method === "textDocument/didOpen")
      documentUri = msg.params.textDocument.uri;
    else if (
      msg.method === failedMethod &&
      (!failedFile ||
        new URL(msg.params.textDocument.uri).pathname.endsWith(
          "/" + failedFile,
        ))
    )
      send({
        id: msg.id,
        error: {
          code: -32603,
          message: "simulated " + msg.method + " failure",
        },
      });
    else if (msg.method === "workspace/symbol")
      send({
        id: msg.id,
        result: documentUri
          ? [
              {
                name: msg.params.query,
                kind: 13,
                location: {
                  uri: documentUri,
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 18 },
                  },
                },
              },
              ...(workspaceAliases
                ? [
                    {
                      name: msg.params.query,
                      kind: 13,
                      location: {
                        uri: new URL("./b.ts", documentUri).href,
                        range: {
                          start: { line: 0, character: 8 },
                          end: { line: 0, character: 13 },
                        },
                      },
                    },
                  ]
                : []),
            ]
          : [],
      });
    else if (msg.method === "textDocument/documentSymbol")
      send({
        id: msg.id,
        result: flatSymbols
          ? [
              {
                name: "state",
                kind: 13,
                location: {
                  uri: msg.params.textDocument.uri,
                  range: {
                    start: { line: 0, character: 13 },
                    end: { line: 0, character: 18 },
                  },
                },
              },
            ]
          : [
              {
                name: "state",
                kind: 13,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 1, character: 19 },
                },
                selectionRange: {
                  start: { line: 0, character: 13 },
                  end: { line: 0, character: 18 },
                },
              },
            ],
      });
    else if (msg.method === "textDocument/hover")
      send({
        id: msg.id,
        result: {
          contents: {
            kind: "markdown",
            value:
              "**actual mock hover** " +
              msg.params.position.line +
              ":" +
              msg.params.position.character,
          },
        },
      });
    else if (msg.method === "textDocument/definition")
      send({
        id: msg.id,
        result: [
          {
            uri: workspaceAliases
              ? new URL("./a.ts", msg.params.textDocument.uri).href
              : msg.params.textDocument.uri,
            range: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 18 },
            },
          },
        ],
      });
    else if (msg.method === "textDocument/references")
      send({
        id: msg.id,
        result: ["a.ts", "c.ts"].map((file) => ({
          uri: new URL("./" + file, msg.params.textDocument.uri).href,
          range: {
            start: { line: 1, character: 12 },
            end: { line: 1, character: 17 },
          },
        })),
      });
    else if (msg.method === "shutdown") send({ id: msg.id, result: null });
    else if (msg.method === "exit") process.exit(0);
    else if (msg.id !== undefined) send({ id: msg.id, result: null });
  }
});
