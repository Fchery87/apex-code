/**
 * Commands whose target is the filesystem root, the home directory, or a credential
 * location. Spec 2026-10-24-bash-catastrophic-deny.md. This is a permission decision,
 * not a sandbox: a command it does not recognize still asks.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describeProtectedTarget } from "../permissions/protected-paths.ts";

const DESTRUCTIVE = new Set(["rm", "rmdir", "shred", "unlink"]);
const WRAPPERS = new Set(["sudo", "command", "nohup"]);

export function bashCatastrophicReason(command: string, cwd: string, home: string = homedir()): string | undefined {
	const unwrapped = unwrap(command.trim());
	const words = splitWords(unwrapped);
	if (words.length === 0) return undefined;
	const program = words[0];
	if (DESTRUCTIVE.has(program)) {
		const target = destructiveTarget(words.slice(1), cwd, home);
		if (target) return target;
	}
	if (program === "find") {
		const target = findDeleteTarget(words.slice(1), cwd, home);
		if (target) return target;
	}
	return undefined;
}

function unwrap(command: string): string {
	const words = splitWords(command);
	if (words.length >= 3 && (words[0] === "sh" || words[0] === "bash") && words[1] === "-c") {
		return stripQuotes(words.slice(2).join(" "));
	}
	if (words.length >= 2 && WRAPPERS.has(words[0])) {
		const rest = words.slice(1).filter((word) => !word.startsWith("-"));
		return rest.join(" ");
	}
	return command;
}

function destructiveTarget(args: readonly string[], cwd: string, home: string): string | undefined {
	for (const arg of args) {
		if (arg.startsWith("-") && arg !== "-") continue;
		const reason = catastrophicPath(arg, cwd, home);
		if (reason) return reason;
	}
	return undefined;
}

function findDeleteTarget(args: readonly string[], cwd: string, home: string): string | undefined {
	if (!args.includes("-delete")) return undefined;
	const paths = args.filter((arg) => !arg.startsWith("-"));
	const target = paths[0] ?? ".";
	return catastrophicPath(target, cwd, home);
}

function catastrophicPath(token: string, cwd: string, home: string): string | undefined {
	const expanded = expandHome(stripQuotes(token), home);
	if (expanded === "/" || expanded === "/*") return `${token} is the filesystem root`;
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const root = resolve("/");
	if (absolute === root) return `${token} resolves to the filesystem root`;
	const homeResolved = resolve(home);
	if (absolute === homeResolved) return `${token} is the home directory`;
	if (isWithin(homeResolved, absolute) && absolute !== homeResolved) {
		const protectedReason = describeProtectedTarget(absolute);
		if (protectedReason) return protectedReason;
	}
	const protectedReason = describeProtectedTarget(absolute);
	if (protectedReason && !isWithin(resolve(cwd), absolute)) return protectedReason;
	return undefined;
}

function expandHome(token: string, home: string): string {
	if (token === "~" || token === "$HOME" || token === "$" + "{HOME}") return home;
	if (token.startsWith("~/")) return join(home, token.slice(2));
	return token;
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[lastIndex(value)];
		if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
	}
	return value;
}

function lastIndex(value: string): number {
	return value.length - 1;
}

function splitWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) words.push(current);
	return words;
}
