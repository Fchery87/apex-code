#!/usr/bin/env node

import { describeProtectedPush } from "./push-target.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const refusal = describeProtectedPush(Buffer.concat(chunks).toString("utf8"), process.env);
if (refusal) {
	console.error(refusal);
	process.exit(1);
}
