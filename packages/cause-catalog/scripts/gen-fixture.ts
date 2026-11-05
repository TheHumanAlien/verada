import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractFixture } from "../src/fixture.js";

const out = fileURLToPath(new URL("../../../contracts/test/fixtures/catalog.json", import.meta.url));
writeFileSync(out, JSON.stringify(contractFixture(), null, 2) + "\n");
process.stdout.write(`wrote ${out}\n`);
