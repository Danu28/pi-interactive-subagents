/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
	// Windows drive-root recursive delete (C:/, C:\, etc.)
	/\brm\s+[^\n]*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)[^\n]*(\s|^)[a-zA-Z]:[\\/]/i,
	// rm with long options / `--` separator aimed at root
	/\brm\s+[^\n]*--[^\n]*(\s|^)(\/|~)/,
	// Shell-variable command indirection hiding rm (e.g. `r=rm; $r -rf /`)
	/\$\w+\s+[^\n]*-[a-zA-Z]*r[a-zA-Z]*[^\n]*\s(\/|~)/,
	// Native Windows destructive commands. `del`/`erase` and `rd`/`rmdir` are
	// only blocked when they carry a destructive switch (/f /s /q) or target a
	// Windows drive path, so a Unix `rmdir /tmp` is NOT a false positive.
	/\b(del|erase)\s+[^\n]*(\/[fsq]\b|[a-zA-Z]:[\\/])/i,
	/\b(rd|rmdir)\s+[^\n]*(\/[sq]\b|[a-zA-Z]:[\\/])/i,
	/\bformat\s+[a-zA-Z]:/i,
	// PowerShell Remove-Item / `ri` with -r or any -Recurse abbreviation.
	/\b(remove-item|ri)\b[^\n]*\s-r(e(c(u(r(s(e)?)?)?)?)?)?\b/i,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
