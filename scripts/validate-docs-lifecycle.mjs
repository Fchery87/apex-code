import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, normalize, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const docsDir = join(root, "docs");
const roadmapPath = join(docsDir, "roadmap.md");
const plansDir = join(docsDir, "plans");
const specsDir = join(docsDir, "specs");
const contractsPath = join(docsDir, "architecture", "contracts.md");
const errors = [];

function report(path, message) {
	errors.push(`${basename(path)}: ${message}`);
}

async function markdownFiles(directory) {
	if (!existsSync(directory)) return [];
	return (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

function planLinks(markdown) {
	const links = new Set();
	for (const match of markdown.matchAll(/\[[^\]]+\]\((plans\/[^)]+\.md)\)/g)) {
		links.add(match[1]);
	}
	return links;
}

function roadmapPhases(markdown) {
	const phases = [];
	for (const line of markdown.split(/\r?\n/)) {
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		if (cells.length < 3 || !/^\d+(?:[a-z])?$/i.test(cells[0])) continue;
		const number = Number.parseInt(cells[0], 10);
		const state = cells[2].replaceAll("*", "").toLowerCase();
		phases.push({ number, state });
	}
	return phases;
}

function contractSummary(markdown) {
	const contracts = new Map();
	for (const line of markdown.split(/\r?\n/)) {
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		if (cells.length < 4 || cells[0] === "Contract" || /^-+$/.test(cells[0])) continue;
		const status = cells[1].match(/\b(open|settled)\b/i)?.[1].toLowerCase();
		if (status) contracts.set(cells[0].replaceAll("*", "").trim(), { status, settleBy: cells[3] });
	}
	return contracts;
}

/**
 * The roadmap repeats the cross-phase contract table that `contracts.md` owns. Scoped to
 * that section so the phase and follow-up tables above it cannot be mistaken for it.
 */
function roadmapContracts(markdown) {
	const heading = markdown.match(/^#+\s+Cross-phase contracts\s*$/im);
	if (!heading) return new Map();
	// Past the end of the heading line, or the next `^#+` search re-matches this one.
	const rest = markdown.slice(heading.index + heading[0].length);
	const next = rest.search(/^#+\s+/m);
	return contractSummary(next === -1 ? rest : rest.slice(0, next));
}

function contractSections(markdown) {
	const sections = new Map();
	const matches = [...markdown.matchAll(/^#\s+\d+\.\s+(.+?)\s+[—-]\s+(open|settled)\s*$/gim)];
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const end = matches[index + 1]?.index ?? markdown.length;
		sections.set(match[1].trim(), {
			status: match[2].toLowerCase(),
			body: markdown.slice(match.index, end),
		});
	}
	return sections;
}

const roadmap = await readFile(roadmapPath, "utf8");
const links = planLinks(roadmap);
const planFiles = await markdownFiles(plansDir);
const livePlans = new Set();

for (const link of links) {
	const linkedPath = resolve(docsDir, normalize(link));
	const insidePlans = linkedPath.startsWith(`${resolve(plansDir)}${sep}`);
	if (!insidePlans || !existsSync(linkedPath)) report(roadmapPath, `plan link does not exist: ${link}`);
}

for (const path of planFiles) {
	const markdown = await readFile(path, "utf8");
	const openingLines = markdown.split(/\r?\n/).slice(0, 5);
	const statusLine = openingLines.find((line) => /^\*\*Status:\*\*/i.test(line.trim()));
	if (!statusLine) {
		report(path, "expected a **Status:** line within the first 5 lines");
		continue;
	}
	if (/\b(?:complete|completed|done|landed)\b/i.test(statusLine)) {
		report(path, "completed plans must be deleted");
		continue;
	}
	livePlans.add(`plans/${basename(path)}`);
}

for (const livePlan of livePlans) {
	if (!links.has(livePlan)) report(join(docsDir, livePlan), "live plan is not linked from docs/roadmap.md");
}

for (const path of await markdownFiles(specsDir)) {
	const markdown = await readFile(path, "utf8");
	if (!/^##\s+Deletion inventory\s*$/im.test(markdown)) {
		report(path, "expected a Deletion inventory section");
	}
}

const contracts = await readFile(contractsPath, "utf8");
const summaries = contractSummary(contracts);
const sections = contractSections(contracts);
const phases = roadmapPhases(roadmap);
const highestStartedPhase = Math.max(0, ...phases.filter(({ state }) => /landed|active/.test(state)).map(({ number }) => number));

for (const [name, summary] of summaries) {
	const section = sections.get(name);
	if (!section) {
		report(contractsPath, `${name}: summary has no matching contract section`);
		continue;
	}
	if (summary.status !== section.status) {
		report(contractsPath, `${name}: summary is ${summary.status} but section is ${section.status}`);
	}
	if (summary.status === "open") {
		const deadlineText = `${summary.settleBy} ${section.body}`;
		const deadline = Number.parseInt(deadlineText.match(/(?:start of )?Phase\s+(\d+)/i)?.[1] ?? "", 10);
		if (Number.isInteger(deadline) && highestStartedPhase > deadline) {
			report(contractsPath, `${name}: open deadline has passed (Phase ${deadline} is landed)`);
		}
	}
}

for (const name of sections.keys()) {
	if (!summaries.has(name)) report(contractsPath, `${name}: contract section is missing from the summary table`);
}

// The same statuses live in two files, and only `contracts.md` was ever checked. A
// roadmap row could therefore go on saying a contract was open for as long as nobody
// happened to read both, which is what it did.
for (const [name, row] of roadmapContracts(roadmap)) {
	const authoritative = summaries.get(name);
	if (!authoritative) {
		report(roadmapPath, `${name}: roadmap names a contract absent from contracts.md`);
		continue;
	}
	if (row.status !== authoritative.status) {
		report(roadmapPath, `${name}: roadmap says ${row.status} but contracts.md says ${authoritative.status}`);
	}
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exitCode = 1;
} else {
	console.log("Documentation lifecycle validation passed.");
}
