/**
 * pi-test — Test runner dashboard for pi.
 *
 * /test              → auto-detect and run tests (vitest, jest, mocha, pytest, go test)
 * /test-watch        → re-run tests on file changes
 * /test-coverage     → run with coverage report
 *
 * Auto-detects test framework from package.json / project files.
 * Colorized pass/fail output, summary stats, timing.
 * LLM tool: run_tests — execute tests and return structured results.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";

const RST = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

type Framework = "vitest" | "jest" | "mocha" | "pytest" | "go" | "cargo" | "npm" | "unknown";

interface TestResult {
	framework: Framework;
	passed: number;
	failed: number;
	skipped: number;
	total: number;
	duration: number;
	output: string;
	success: boolean;
}

function detectFramework(cwd: string): { framework: Framework; cmd: string } {
	// Check package.json for scripts and deps
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			const scripts = pkg.scripts || {};

			if (deps.vitest || scripts.test?.includes("vitest")) {
				return { framework: "vitest", cmd: "npx vitest run --reporter=verbose" };
			}
			if (deps.jest || scripts.test?.includes("jest")) {
				return { framework: "jest", cmd: "npx jest --verbose" };
			}
			if (deps.mocha || scripts.test?.includes("mocha")) {
				return { framework: "mocha", cmd: "npx mocha --reporter spec" };
			}
			if (scripts.test) {
				return { framework: "npm", cmd: "npm test" };
			}
		} catch { /* ignore */ }
	}

	// Python
	if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
		return { framework: "pytest", cmd: "python -m pytest -v" };
	}

	// Go
	if (existsSync(join(cwd, "go.mod"))) {
		return { framework: "go", cmd: "go test -v ./..." };
	}

	// Rust
	if (existsSync(join(cwd, "Cargo.toml"))) {
		return { framework: "cargo", cmd: "cargo test" };
	}

	return { framework: "unknown", cmd: "" };
}

function runTests(cmd: string, cwd: string): { output: string; exitCode: number; duration: number } {
	const start = Date.now();
	try {
		const output = execSync(cmd, {
			encoding: "utf-8",
			timeout: 300000, // 5 min
			maxBuffer: 10 * 1024 * 1024,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { output, exitCode: 0, duration: Date.now() - start };
	} catch (e: any) {
		return {
			output: (e.stdout || "") + "\n" + (e.stderr || ""),
			exitCode: e.status || 1,
			duration: Date.now() - start,
		};
	}
}

function parseResults(output: string, framework: Framework, exitCode: number, duration: number): TestResult {
	let passed = 0, failed = 0, skipped = 0;

	if (framework === "vitest" || framework === "jest") {
		// Parse "Tests: X passed, Y failed, Z skipped, N total" or similar
		const passMatch = output.match(/(\d+)\s+pass/i);
		const failMatch = output.match(/(\d+)\s+fail/i);
		const skipMatch = output.match(/(\d+)\s+skip/i);
		if (passMatch) passed = parseInt(passMatch[1]);
		if (failMatch) failed = parseInt(failMatch[1]);
		if (skipMatch) skipped = parseInt(skipMatch[1]);

		// Vitest format: "Tests  3 passed (3)"
		const vitestMatch = output.match(/Tests\s+(\d+)\s+passed.*?(?:(\d+)\s+failed)?/);
		if (vitestMatch) {
			passed = parseInt(vitestMatch[1]);
			if (vitestMatch[2]) failed = parseInt(vitestMatch[2]);
		}
	} else if (framework === "pytest") {
		const m = output.match(/(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+skipped)?/);
		if (m) {
			passed = parseInt(m[1]) || 0;
			failed = parseInt(m[2] || "0");
			skipped = parseInt(m[3] || "0");
		}
	} else if (framework === "go") {
		const passLines = output.match(/--- PASS/g);
		const failLines = output.match(/--- FAIL/g);
		const skipLines = output.match(/--- SKIP/g);
		passed = passLines?.length || 0;
		failed = failLines?.length || 0;
		skipped = skipLines?.length || 0;
	} else if (framework === "cargo") {
		const m = output.match(/(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/);
		if (m) { passed = parseInt(m[1]); failed = parseInt(m[2]); skipped = parseInt(m[3]); }
	} else {
		// Generic: count checkmarks and x marks or "pass"/"fail" lines
		passed = (output.match(/[✓✔]|PASS|pass(?:ed)?/gi) || []).length;
		failed = (output.match(/[✗✘✕]|FAIL|fail(?:ed)?/gi) || []).length;
	}

	// If we couldn't parse but have exit code, infer
	if (passed === 0 && failed === 0) {
		if (exitCode === 0) passed = 1;
		else failed = 1;
	}

	return {
		framework,
		passed,
		failed,
		skipped,
		total: passed + failed + skipped,
		duration,
		output,
		success: exitCode === 0,
	};
}

function formatResult(result: TestResult): string {
	const lines: string[] = [];
	const statusIcon = result.success ? `${GREEN}${B}✓ PASS${RST}` : `${RED}${B}✗ FAIL${RST}`;

	lines.push(`${B}${CYAN}── Test Results ──${RST}  ${statusIcon}`);
	lines.push(`  ${D}Framework:${RST} ${result.framework}  ${D}Duration:${RST} ${(result.duration / 1000).toFixed(1)}s`);
	lines.push("");

	// Summary bar
	const total = result.total;
	if (total > 0) {
		const passW = Math.round(result.passed / total * 30);
		const failW = Math.round(result.failed / total * 30);
		const skipW = 30 - passW - failW;
		const bar = `${GREEN}${"█".repeat(passW)}${RST}${RED}${"█".repeat(failW)}${RST}${YELLOW}${"░".repeat(Math.max(0, skipW))}${RST}`;
		lines.push(`  ${bar}`);
	}

	lines.push(`  ${GREEN}${result.passed} passed${RST}  ${result.failed > 0 ? `${RED}${result.failed} failed${RST}  ` : ""}${result.skipped > 0 ? `${YELLOW}${result.skipped} skipped${RST}  ` : ""}${D}${result.total} total${RST}`);

	// Show failure output if any
	if (result.failed > 0) {
		lines.push(`\n  ${RED}${B}Failures:${RST}`);
		// Extract failure blocks
		const failBlocks = result.output.match(/(?:FAIL|AssertionError|Error:).*(?:\n.*){0,5}/g);
		if (failBlocks) {
			for (const block of failBlocks.slice(0, 5)) {
				for (const line of block.split("\n").slice(0, 4)) {
					lines.push(`  ${RED}${line.trim().slice(0, 100)}${RST}`);
				}
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

export default function (api: ExtensionAPI) {
	let watchCleanup: (() => void) | null = null;

	// /test
	api.registerCommand({
		name: "test",
		description: "Run tests (auto-detects framework)",
		args: [{ name: "filter", description: "Test name filter (optional)", required: false }],
		execute: async (ctx) => {
			const cwd = process.cwd();
			const { framework, cmd } = detectFramework(cwd);

			if (framework === "unknown") {
				ctx.ui.notify("No test framework detected. Supports: vitest, jest, mocha, pytest, go test, cargo test", "warning");
				return;
			}

			ctx.ui.setStatus("test", "Running tests...");
			const filter = ctx.args[0];
			const fullCmd = filter ? `${cmd} -- ${filter}` : cmd;

			const { output, exitCode, duration } = runTests(fullCmd, cwd);
			const result = parseResults(output, framework, exitCode, duration);

			ctx.ui.setStatus("test", undefined);
			ctx.ui.notify(formatResult(result), "info");
		},
	});

	// /test-coverage
	api.registerCommand({
		name: "test-coverage",
		description: "Run tests with coverage report",
		execute: async (ctx) => {
			const cwd = process.cwd();
			const { framework } = detectFramework(cwd);

			let cmd: string;
			switch (framework) {
				case "vitest": cmd = "npx vitest run --coverage --reporter=verbose"; break;
				case "jest": cmd = "npx jest --coverage --verbose"; break;
				case "pytest": cmd = "python -m pytest --cov -v"; break;
				case "go": cmd = "go test -coverprofile=coverage.out -v ./..."; break;
				case "cargo": cmd = "cargo test -- --show-output"; break;
				default:
					ctx.ui.notify("No test framework detected", "warning");
					return;
			}

			ctx.ui.setStatus("test", "Running tests with coverage...");
			const { output, exitCode, duration } = runTests(cmd, cwd);
			const result = parseResults(output, framework, exitCode, duration);

			// Extract coverage summary
			const covMatch = output.match(/(?:All files|TOTAL|coverage:).*?(\d+(?:\.\d+)?)\s*%/i);
			let covLine = "";
			if (covMatch) {
				const pct = parseFloat(covMatch[1]);
				const color = pct >= 80 ? GREEN : pct >= 50 ? YELLOW : RED;
				covLine = `\n  ${B}Coverage:${RST} ${color}${B}${pct.toFixed(1)}%${RST}`;
			}

			ctx.ui.setStatus("test", undefined);
			ctx.ui.notify(formatResult(result) + covLine, "info");
		},
	});

	// /test-watch
	api.registerCommand({
		name: "test-watch",
		description: "Re-run tests on file changes (toggle)",
		execute: async (ctx) => {
			if (watchCleanup) {
				watchCleanup();
				watchCleanup = null;
				ctx.ui.setStatus("test-watch", undefined);
				ctx.ui.notify("Test watch stopped", "info");
				return;
			}

			const cwd = process.cwd();
			const { framework, cmd } = detectFramework(cwd);
			if (framework === "unknown") {
				ctx.ui.notify("No test framework detected", "warning");
				return;
			}

			// Use vitest/jest native watch if available
			if (framework === "vitest") {
				ctx.ui.notify("Use `npx vitest` for native watch mode. /test-watch polls every 5s.", "info");
			}

			let running = false;
			const interval = setInterval(async () => {
				if (running) return;
				running = true;
				const { output, exitCode, duration } = runTests(cmd, cwd);
				const result = parseResults(output, framework, exitCode, duration);
				const icon = result.success ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
				ctx.ui.setStatus("test-watch", `${icon} ${result.passed}/${result.total} (${(duration / 1000).toFixed(1)}s)`);
				running = false;
			}, 5000);

			watchCleanup = () => clearInterval(interval);
			ctx.ui.setStatus("test-watch", "Watching...");
			ctx.ui.notify("Test watch started (polling every 5s). Run /test-watch again to stop.", "info");
		},
	});

	// LLM tool
	api.registerTool({
		name: "run_tests",
		description: "Run project tests and return structured results (pass/fail counts, failures, duration)",
		parameters: Type.Object({
			filter: Type.Optional(Type.String({ description: "Test name filter" })),
			coverage: Type.Optional(Type.Boolean({ description: "Include coverage" })),
		}),
		execute: async (args) => {
			const cwd = process.cwd();
			const { framework, cmd } = detectFramework(cwd);
			if (framework === "unknown") return "No test framework detected";

			let fullCmd = cmd;
			if (args.coverage) {
				if (framework === "vitest") fullCmd = "npx vitest run --coverage --reporter=verbose";
				else if (framework === "jest") fullCmd = "npx jest --coverage --verbose";
			}
			if (args.filter) fullCmd += ` -- ${args.filter}`;

			const { output, exitCode, duration } = runTests(fullCmd, cwd);
			const result = parseResults(output, framework, exitCode, duration);

			return JSON.stringify({
				framework: result.framework,
				success: result.success,
				passed: result.passed,
				failed: result.failed,
				skipped: result.skipped,
				total: result.total,
				durationMs: result.duration,
				failureOutput: result.failed > 0 ? result.output.slice(-2000) : undefined,
			}, null, 2);
		},
	});
}
