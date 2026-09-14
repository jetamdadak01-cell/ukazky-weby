// Spusteni vsech testu PitWise funkci:   node run.mjs
//
// Funkce v pitwise/functions/ jsou .js bez package.json, takze by je node cetl jako CommonJS
// a spadl na "export". Runner je proto nakopiruje do _build/ s priponou .mjs (jen prejmenovani,
// obsah se nemeni) a pusti nad nimi testy. Nikdy netestuje proti zivemu Stripu/Payhipu -
// vsechno je mockovane uvnitr testu.
import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const api = join(here, "..", "pitwise", "functions", "api");
const build = join(here, "_build");

mkdirSync(build, { recursive: true });
for (const [from, to] of [["refund.js", "refund.mjs"], ["payhip-hook.js", "hook.mjs"], ["watchdog.js", "watchdog.mjs"]]) {
  copyFileSync(join(api, from), join(build, to));
}

let bad = 0;
for (const t of ["test-refund.mjs", "test-watchdog.mjs"]) {
  console.log("\n########## " + t + " ##########");
  const r = spawnSync(process.execPath, [join(here, t)], { stdio: "inherit" });
  if (r.status !== 0) bad++;
}
console.log(bad ? "\n>>> " + bad + " sada(y) testu SELHALA" : "\n>>> vse proslo");
process.exit(bad ? 1 : 0);
