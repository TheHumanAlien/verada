// Local mock of the browser-facing API: the real route layer (CORS, rate limits, cursors, SSE)
// over the in-memory fixture repository. Used for browser integration checks; never deployed.
//   pnpm --filter @verada/indexer exec tsx scripts/serve-fixtures.ts [port]
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { ActivityBus } from "../src/api/bus";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "../test/api.fixtures";

const port = Number(process.argv[2] ?? process.env.PORT ?? 42069);
const repo = fixtureRepo();
const config = readApiConfig(process.env);
const bus = new ActivityBus(() => repo.listActivity({ limit: 100 }), config.ssePollMs);
const app = createApi({
  repo,
  config,
  bus,
  search: { search: async () => [] },
});
createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const r = await app.fetch(
    new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, signal: ac.signal }),
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) Readable.fromWeb(r.body as never).pipe(res);
  else res.end();
}).listen(port, "127.0.0.1", () => console.log(`fixture indexer on http://127.0.0.1:${port}`));
