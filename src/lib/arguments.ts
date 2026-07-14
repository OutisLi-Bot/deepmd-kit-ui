// SPDX-License-Identifier: LGPL-3.0-or-later

import type { CatalogArgument, FieldValue, Workflow } from "../types";

export interface ArgumentBuildResult {
  args: string[];
  missing: string[];
}

export function defaultFieldValues(workflow: Workflow): Record<string, FieldValue> {
  return Object.fromEntries(
    workflow.arguments.map((argument) => {
      if (argument.kind === "boolean") {
        return [argument.id, Boolean(argument.default)];
      }
      if (Array.isArray(argument.default)) {
        return [argument.id, argument.default.join("\n")];
      }
      return [argument.id, argument.default == null ? "" : String(argument.default)];
    }),
  );
}

export function preferredFlag(argument: CatalogArgument): string | undefined {
  return (
    argument.flags.find((flag) => flag.startsWith("--")) ??
    argument.flags.at(0)
  );
}

export function fieldLabel(argument: CatalogArgument): string {
  const source = argument.positional
    ? argument.id
    : preferredFlag(argument)?.replace(/^--?/, "") ?? argument.id;
  return source
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function isMultiple(argument: CatalogArgument): boolean {
  return (
    argument.nargs === "+" ||
    argument.nargs === "*" ||
    (typeof argument.nargs === "number" && argument.nargs > 1)
  );
}

function valueTokens(argument: CatalogArgument, value: string): string[] {
  if (!isMultiple(argument)) {
    return value.trim() ? [value.trim()] : [];
  }
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildArguments(
  workflow: Workflow,
  values: Record<string, FieldValue>,
  touched: ReadonlySet<string>,
  rawArguments: string,
): ArgumentBuildResult {
  const args: string[] = [];
  const missing: string[] = [];

  for (const argument of workflow.arguments) {
    if (
      argument.condition &&
      String(values[argument.condition.field] ?? "") !== argument.condition.equals
    ) {
      continue;
    }
    const value = values[argument.id];
    if (argument.kind === "boolean") {
      const checked = Boolean(value);
      const defaultValue = Boolean(argument.default);
      if (checked !== defaultValue) {
        const flag = preferredFlag(argument);
        if (flag) args.push(flag);
      }
      continue;
    }

    const tokens = valueTokens(argument, String(value ?? ""));
    const shouldEmit = touched.has(argument.id) || (argument.required && argument.default == null);
    if (argument.required && tokens.length === 0 && argument.default == null) {
      missing.push(fieldLabel(argument));
      continue;
    }
    if (!shouldEmit || tokens.length === 0) continue;
    if (!argument.positional) {
      const flag = preferredFlag(argument);
      if (flag) args.push(flag);
    }
    args.push(...tokens);
  }

  if (rawArguments.trim()) {
    args.push(...splitCommandLine(rawArguments));
  }
  return { args, missing };
}

export function quoteArgument(argument: string): string {
  if (/^[\w./:@%+=,-]+$/.test(argument)) return argument;
  return `"${argument.replaceAll('"', '\\"')}"`;
}

export function splitCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = value.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (escaped) {
      token += character;
      escaped = false;
    } else if (
      character === "\\" &&
      quote !== "'" &&
      (next === "\\" || next === '"')
    ) {
      escaped = true;
    } else if (quote && character === quote) {
      quote = null;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (!quote && /\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}
