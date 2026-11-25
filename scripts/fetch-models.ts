/**
 * `npm run voice`: fetch the voice and hearing models (once) and say a test line to check they work.
 * Its own script on purpose: server modules are bundled into one file, where an "am I the main
 * program?" block is true and runs at plugin start-up, stopping the server from ever connecting.
 */
import { STT_MODEL, warmHearing } from "../server/hearing.ts";
import { MODELS_DIR, speak, warm } from "../server/voice.ts";

const t0 = performance.now();
await warm();
const s = await speak("Hi, I'm Dudeling. Let's learn something.");
console.log(`Voice ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (model in ${MODELS_DIR}); ${s.durationMs} ms test line.`);
const t1 = performance.now();
await warmHearing();
console.log(`Hearing (${STT_MODEL}) ready in ${((performance.now() - t1) / 1000).toFixed(1)} s.`);
