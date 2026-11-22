import { spawnFor } from "../adapters/index.js";
import { relayDepsFromProcess, relayMain } from "./main.js";

// 🛑 NO DECISIONS HERE, ON PURPOSE. An executable runs at import, so nothing
// in this file can be reached by a test — which is #359's shape. Every choice
// it would otherwise make lives in `relayDepsFromProcess`.
relayMain(process.argv.slice(2), relayDepsFromProcess(process, spawnFor));
