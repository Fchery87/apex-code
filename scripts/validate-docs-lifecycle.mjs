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

// The state always sits in the cell before the spec link, in both the phase table
// (Phase, Name, State, Spec, Plan) and the follow-up table (Follow-up, State, Spec,
// Plan). Reading the position rather than searching for the words "landed" or
// "active" keeps a row with any other state readable instead of invisible.
function roadmapSpecLinks(markdown) {
	const links = new Map();
	for (const line of markdown.split(/\r?\n/)) {
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		if (cells.length < 4) continue;
		const specIndex = cells.findIndex((cell) => /\(specs\/[^)]+\.md\)/.test(cell));
		if (specIndex < 1) continue;
		const state = cells[specIndex - 1].replaceAll("*", "").toLowerCase();
		// Phase 12 links two specs from one cell, so every link in it takes the row's state.
		for (const [, spec] of cells[specIndex].matchAll(/\((specs\/[^)]+\.md)\)/g)) {
			links.set(spec, { phase: cells[0], state });
		}
	}
	return links;
}

// One direction only. The roadmap states that a row without a written file is a
// reservation, so a row with no ADR is legitimate and an ADR with no row is not.
function roadmapAdrNumbers(markdown) {
	return new Set([...markdown.matchAll(/^\|\s*(\d{4})\s*\|/gm)].map((match) => match[1]));
}

function specStatus(markdown) {
	const matches = [...markdown.matchAll(/^\*\*Status:\*\*\s*(Draft|Active|Landed|Superseded)\s*$/gim)];
	return matches.length === 1 ? matches[0][1] : null;
}

// An ADR's metadata is one paragraph rather than one line. `**Supersedes:**` carrying six
// links wraps, and ADR 0019 already showed a status that is a phrase, not a keyword.
function adrHeader(markdown) {
	// `$` is per-line under `m`, which would truncate a wrapped header at its first line.
	return markdown.match(/^\*\*Status:\*\*[\s\S]*?(?=\r?\n\r?\n|(?![\s\S]))/m)?.[0] ?? null;
}

function adrStatus(header) {
	return header.match(/^\*\*Status:\*\*\s*([^·\r\n]+)/)?.[1].trim() ?? "";
}

// `**Supersedes:** parts of [ADR 0019](...)` (ADR 0022) retires some of a decision and
// leaves the rest standing, so it is read as a claim that asserts nothing about status.
function supersessionClaims(header) {
	const value = header.split("**Supersedes:**")[1];
	if (value === undefined) return [];
	const claims = [];
	let cursor = 0;
	for (const match of value.matchAll(/\[ADR (\d{4})\]\(([^)]+)\)/g)) {
		claims.push({
			number: match[1],
			file: match[2],
			partial: /parts of/i.test(value.slice(cursor, match.index)),
		});
		cursor = match.index + match[0].length;
	}
	return claims;
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

const specLinks = roadmapSpecLinks(roadmap);
for (const path of (await markdownFiles(specsDir)).filter((path) => basename(path) !== "TEMPLATE.md")) {
	const markdown = await readFile(path, "utf8");
	if (!/^##\s+Deletion inventory\s*$/im.test(markdown)) {
		report(path, "expected a Deletion inventory section");
	}
	const status = specStatus(markdown);
	if (!status) {
		report(path, "expected exactly one canonical **Status:** line (Draft, Active, Landed, or Superseded)");
		continue;
	}
	// Supersession says a later spec replaced this one, which is orthogonal to whether
	// the work shipped, so it agrees with any row state.
	if (status === "Superseded") continue;

	const roadmapLink = specLinks.get(`specs/${basename(path)}`);
	if (!roadmapLink) {
		report(path, "no docs/roadmap.md row links this spec, so nothing checks its status");
		continue;
	}
	// Both directions. A spec understating landed work is the noisier failure; a spec
	// claiming Landed for work in progress is the one that misleads a reader into
	// skipping it, which is the failure this gate exists to prevent.
	const landed = /landed/.test(roadmapLink.state);
	if (landed && status !== "Landed") {
		report(path, `roadmap marks its row landed but spec is ${status}`);
	}
	if (!landed && status === "Landed") {
		report(path, `spec is Landed but its roadmap row is ${roadmapLink.state}`);
	}
}

const registeredAdrs = roadmapAdrNumbers(roadmap);
for (const path of await markdownFiles(join(docsDir, "adr"))) {
	const number = basename(path).match(/^(\d{4})-/)?.[1];
	if (number && !registeredAdrs.has(number)) {
		report(roadmapPath, `ADR ${number} is written but absent from the roadmap's allocation table`);
	}
}

// An ADR that says it supersedes another is making a claim about a second file, and
// nothing checked it. ADR 0032 shipped claiming six supersessions while all six targets
// still read `Accepted`, so `docs/adr/` described a subsystem that no longer existed and
// every gate passed. Both directions are checked, because a target marked `Superseded`
// with nothing claiming it is the same drift seen from the other end.
const adrs = new Map();
for (const path of await markdownFiles(join(docsDir, "adr"))) {
	const number = basename(path).match(/^(\d{4})-/)?.[1];
	if (!number) continue;
	const header = adrHeader(await readFile(path, "utf8"));
	if (!header) {
		report(path, "expected a `**Status:**` metadata line");
		continue;
	}
	adrs.set(number, { path, header, status: adrStatus(header), supersedes: supersessionClaims(header) });
}

for (const [number, adr] of adrs) {
	for (const claim of adr.supersedes) {
		const target = adrs.get(claim.number);
		if (!target) {
			report(adr.path, `claims to supersede ADR ${claim.number}, which does not exist`);
			continue;
		}
		if (basename(target.path) !== claim.file) {
			report(adr.path, `links ADR ${claim.number} as ${claim.file}, but the file is ${basename(target.path)}`);
		}
		// A partial supersession leaves the target in force, so it keeps its own status.
		if (claim.partial) continue;
		if (target.status !== "Superseded") {
			report(target.path, `ADR ${number} supersedes this, but its status is ${target.status}`);
		}
		if (!target.header.includes(`**Superseded by:** [ADR ${number}]`)) {
			report(target.path, `ADR ${number} supersedes this, but it names no \`**Superseded by:** [ADR ${number}]\``);
		}
	}
}

for (const [number, adr] of adrs) {
	if (adr.status !== "Superseded") continue;
	const by = adr.header.match(/\*\*Superseded by:\*\*\s*\[ADR (\d{4})\]/)?.[1];
	if (!by) {
		report(adr.path, "is Superseded but names no `**Superseded by:** [ADR NNNN]`");
		continue;
	}
	const claimant = adrs.get(by);
	if (!claimant) {
		report(adr.path, `names ADR ${by} as superseding it, but that ADR does not exist`);
		continue;
	}
	if (!claimant.supersedes.some((claim) => claim.number === number && !claim.partial)) {
		report(claimant.path, `ADR ${number} names this as superseding it, but its \`**Supersedes:**\` does not list it`);
	}
}

// A document that names a file is making a checkable claim, and nothing checked it. Four
// pages npm publishes kept describing a deleted subsystem, a plan carried a "not started"
// task pointing at `core/sandbox/cli-supervisor.ts` after that file was gone, and a README
// linked `containerization.md` one directory away from the file. All three are the same
// failure: prose outliving what it describes. Code fences are skipped, because an example
// of how to write a link is not a link.
const HISTORICAL_DOCS = ["docs/specs/", "docs/adr/", "docs/research/", "docs/roadmap.md", "docs/upstream-log.md"];
const UNREAD_DOC_DIRS = new Set([".git", ".worktrees", ".apex-code", ".pi", "node_modules", "dist", "vendor", "examples"]);

async function currentDocs(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (UNREAD_DOC_DIRS.has(entry.name)) continue;
			found.push(...(await currentDocs(path)));
			continue;
		}
		if (!entry.name.endsWith(".md") || entry.name === "CHANGELOG.md") continue;
		const rel = relative(root, path).split(sep).join("/");
		if (HISTORICAL_DOCS.some((skip) => rel === skip || rel.startsWith(skip))) continue;
		found.push(path);
	}
	return found;
}

// A fixture tree has no `packages/`, and this check must not depend on the repo's shape.
const packageDirs = existsSync(join(root, "packages"))
	? (await readdir(join(root, "packages"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, "packages", entry.name))
	: [];
const sourceRoots = [root, ...packageDirs, ...packageDirs.map((dir) => join(dir, "src"))];

for (const path of await currentDocs(root)) {
	// Two variants on purpose. A link shown inside a fence or a code span is an example of
	// a link, not one, so the link scan reads neither. The source-file scan reads inside
	// code spans by design, because a backticked path is exactly what it looks for, so it
	// sees everything outside fences. Markdown fences come in backtick and tilde forms.
	const outsideFences = (await readFile(path, "utf8"))
		.replace(/^~~~[\s\S]*?^~~~/gm, "")
		.replace(/```[\s\S]*?```/g, "");
	const outsideCode = outsideFences.replace(/`[^`\n]*`/g, "");

	for (const match of outsideCode.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
		const target = match[1].split("#")[0];
		if (!target || /^(?:[a-z][a-z0-9+.-]*:|<)/i.test(target)) continue;
		if (!existsSync(join(path, "..", target))) report(path, `links ${target}, which does not exist`);
	}

	for (const match of outsideFences.matchAll(/`((?:src|core|scripts|test|packages)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js))(?::\d+)?`/g)) {
		const named = match[1];
		if (!sourceRoots.some((dir) => existsSync(join(dir, named)))) {
			report(path, `names the source file ${named}, which does not exist`);
		}
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
