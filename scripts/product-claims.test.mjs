import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkProductClaims, generatedAgentInventory } from "./product-claims.mjs";

test("inventory is generated from shipped definitions and stale claims fail", () => {
 const inventory = generatedAgentInventory();
 assert.match(inventory, /`debugger`/);
 assert.match(inventory, /`verifier`/);
 assert.deepEqual(checkProductClaims(`${inventory}\nversioned JSON definition; not crash-resumable`, "Built-in agent types are listed in the README."), []);
 assert.ok(checkProductClaims("Two built-in types ship: explore, general", "SpecEngine + governance").length > 0);
});

test("packed README documents the same agent inventory and JSON workflow boundary", () => {
 const readme = readFileSync(new URL("../packages/coding-agent/README.md", import.meta.url), "utf8");
 assert.ok(readme.includes(generatedAgentInventory()));
 assert.match(readme, /versioned JSON definition/);
 assert.match(readme, /not crash-resumable/);
 assert.match(readme, /JavaScript workflow files/);
});
