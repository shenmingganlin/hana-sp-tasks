import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_VERSION } from "../lib/capabilities.js";
import { validateCompanionZip } from "./companion-zip.mjs";

const companionRoot = new URL("../../sp-hana-bridge/", import.meta.url);
const build = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/build.mjs", companionRoot))], { stdio: "inherit", windowsHide: true });
if (build.status !== 0) throw new Error("SP extension build failed.");
const manifest = JSON.parse(await readFile(new URL("manifest.json", companionRoot), "utf8"));
if (manifest.id !== "hana-sp-bridge" || manifest.version !== BUNDLED_PLUGIN_VERSION) throw new Error("The companion version does not match Task Desk.");
const bytes = await readFile(new URL("dist/hana-sp-bridge.zip", companionRoot));
const output = new URL("../assets/companion/", import.meta.url);
const metadata = {
  id: manifest.id, name: manifest.name, version: manifest.version, minSpVersion: manifest.minSupVersion,
  protocolVersion: 1, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
};
validateCompanionZip(bytes, metadata);
await mkdir(output, { recursive: true });
await writeFile(new URL("hana-sp-bridge.zip", output), bytes);
await writeFile(new URL("package.json", output), JSON.stringify(metadata, null, 2) + "\n");
console.log(`Bundled SP extension ${metadata.version} (${metadata.size} bytes) in Task Desk.`);
