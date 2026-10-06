// CareMate AI API — 煙霧測試（不需要 AI 金鑰即可跑）
// 驗證：/healthz、缺 input 回 400、未知路徑回 404、CORS 標頭
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", (d) => process.stderr.write(d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(900);

  const h = await fetch(`${BASE}/healthz`);
  assert.equal(h.status, 200, "healthz 應回 200");
  const hj = await h.json();
  assert.equal(hj.ok, true, "healthz 應回 ok:true");
  console.log(`[PASS] GET /healthz -> 200 ok=${hj.ok} ai=${hj.ai}`);

  const bad = await fetch(`${BASE}/api/parse-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "" }),
  });
  assert.equal(bad.status, 400, "缺 input 應回 400");
  console.log(`[PASS] POST /api/parse-tasks（空 input）-> 400 ${JSON.stringify(await bad.json())}`);

  const nf = await fetch(`${BASE}/nope`);
  assert.equal(nf.status, 404, "未知路徑應回 404");
  console.log("[PASS] GET /nope -> 404");

  const cors = await fetch(`${BASE}/healthz`);
  assert.equal(cors.headers.get("access-control-allow-origin"), "*", "應有 CORS 標頭");
  console.log("[PASS] CORS Access-Control-Allow-Origin: *");

  console.log("API SMOKE PASSED");
}

main()
  .catch((e) => {
    console.error("API SMOKE FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => child.kill());
