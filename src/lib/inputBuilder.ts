// SPDX-License-Identifier: LGPL-3.0-or-later

import type { InputArgument, InputVariant, JsonValue, TrainingInputSchema } from "../types";

export type TrainingDraft = Record<string, JsonValue>;

export const COMMON_INPUT_FIELDS = new Set([
  "type_map",
  "descriptor",
  "fitting_net",
  "training_data",
  "validation_data",
  "systems",
  "batch_size",
  "numb_steps",
  "seed",
  "disp_freq",
  "save_freq",
  "start_lr",
  "stop_lr",
  "stop_lr_ratio",
  "decay_steps",
  "warmup_steps",
  "warmup_ratio",
  "weight_decay",
  "rcut",
  "rcut_smth",
  "sel",
  "nsel",
  "neuron",
  "precision",
  "use_compile",
  "enable_tf32",
  "validation_freq",
  "save_best",
]);

export function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fallbackValue(argument: InputArgument): JsonValue {
  if (Object.hasOwn(argument, "default")) return structuredClone(argument.default as JsonValue);
  if (argument.type.includes("dict")) return {};
  if (argument.type.includes("list")) return [];
  if (argument.type.includes("bool")) return false;
  if (argument.type.some((type) => type === "int" || type === "float")) return "";
  return "";
}

function mergeChoice(target: Record<string, JsonValue>, choice: InputArgument): void {
  const choiceValue = initializeObject(choice);
  Object.assign(target, choiceValue);
}

export function initializeObject(argument: InputArgument): Record<string, JsonValue> {
  const value: Record<string, JsonValue> = {};
  for (const variant of Object.values(argument.sub_variants)) {
    if (!variant.default_tag) continue;
    value[variant.flag_name] = variant.default_tag;
    const choice = variant.choice_dict[variant.default_tag];
    if (choice) mergeChoice(value, choice);
  }
  for (const field of Object.values(argument.sub_fields)) {
    if (!field.optional && !Object.hasOwn(value, field.name)) {
      value[field.name] = initializeValue(field);
    }
  }
  return value;
}

export function initializeValue(argument: InputArgument): JsonValue {
  if (argument.type.includes("dict") && (Object.keys(argument.sub_fields).length || Object.keys(argument.sub_variants).length)) {
    return initializeObject(argument);
  }
  return fallbackValue(argument);
}

export function createTrainingDraft(schema: TrainingInputSchema): TrainingDraft {
  const byName = new Map(schema.arguments.map((argument) => [argument.name, argument]));
  const draft: TrainingDraft = {};
  for (const name of ["model", "learning_rate", "optimizer", "loss", "training"]) {
    const argument = byName.get(name);
    if (argument) draft[name] = initializeValue(argument);
  }
  const trainingArgument = byName.get("training");
  const training = draft.training;
  if (trainingArgument && isObject(training)) {
    const dataArgument = trainingArgument.sub_fields.training_data;
    if (dataArgument) training.training_data = initializeValue(dataArgument);
    training.numb_steps = 1_000_000;
  }
  const learningRate = draft.learning_rate;
  if (isObject(learningRate)) learningRate.start_lr = 0.001;
  return draft;
}

export function activeChoice(variant: InputVariant, value: Record<string, JsonValue>): InputArgument | null {
  const tag = typeof value[variant.flag_name] === "string"
    ? String(value[variant.flag_name])
    : variant.default_tag;
  return variant.choice_dict[tag] ?? null;
}

export function activeFields(argument: InputArgument, value: Record<string, JsonValue>): InputArgument[] {
  const fields = new Map(Object.entries(argument.sub_fields));
  for (const variant of Object.values(argument.sub_variants)) {
    const choice = activeChoice(variant, value);
    if (!choice) continue;
    for (const [name, field] of Object.entries(choice.sub_fields)) fields.set(name, field);
  }
  return [...fields.values()];
}

export function changeVariant(
  argument: InputArgument,
  current: Record<string, JsonValue>,
  variant: InputVariant,
  tag: string,
): Record<string, JsonValue> {
  const next = structuredClone(current);
  for (const choice of Object.values(variant.choice_dict)) {
    for (const name of Object.keys(choice.sub_fields)) delete next[name];
  }
  next[variant.flag_name] = tag;
  const choice = variant.choice_dict[tag];
  if (choice) mergeChoice(next, choice);
  for (const field of Object.values(argument.sub_fields)) {
    if (!field.optional && !Object.hasOwn(next, field.name)) next[field.name] = initializeValue(field);
  }
  return next;
}

export function collectMissing(
  argument: InputArgument,
  rawValue: JsonValue | undefined,
  path = argument.name,
): string[] {
  if (!isObject(rawValue)) return argument.optional ? [] : [path];
  const missing: string[] = [];
  for (const variant of Object.values(argument.sub_variants)) {
    const tag = rawValue[variant.flag_name];
    if ((!tag || typeof tag !== "string") && !variant.optional && !variant.default_tag) {
      missing.push(`${path}.${variant.flag_name}`);
      continue;
    }
    const choice = activeChoice(variant, rawValue);
    if (choice) {
      for (const field of activeFields(choice, rawValue)) {
        if (!field.optional) missing.push(...collectFieldMissing(field, rawValue[field.name], `${path}.${field.name}`));
      }
    }
  }
  for (const field of Object.values(argument.sub_fields)) {
    if (!field.optional) missing.push(...collectFieldMissing(field, rawValue[field.name], `${path}.${field.name}`));
  }
  return [...new Set(missing)];
}

function collectFieldMissing(argument: InputArgument, value: JsonValue | undefined, path: string): string[] {
  if (value === undefined || (value === null && !argument.type.includes("NoneType")) || value === "" || (Array.isArray(value) && value.length === 0)) {
    return [path];
  }
  if (argument.type.includes("dict") && (Object.keys(argument.sub_fields).length || Object.keys(argument.sub_variants).length)) {
    return collectMissing(argument, value, path);
  }
  return [];
}

export function compactInput(value: TrainingDraft): TrainingDraft {
  function compact(item: JsonValue): JsonValue | undefined {
    if (Array.isArray(item)) {
      const entries = item.map(compact).filter((entry): entry is JsonValue => entry !== undefined);
      return entries;
    }
    if (isObject(item)) {
      const entries = Object.entries(item)
        .map(([key, entry]) => [key, compact(entry)] as const)
        .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined);
      return Object.fromEntries(entries);
    }
    return item === "" ? undefined : item;
  }
  return (compact(value) ?? {}) as TrainingDraft;
}

export function displayName(name: string): string {
  const special: Record<string, string> = {
    dpa4: "DPA4",
    dpa3: "DPA3",
    dpa2: "DPA2",
    tf32: "TF32",
    rcut: "Cut-off radius",
    rcut_smth: "Smoothing radius",
    sel: "Selected neighbors",
    numb_steps: "Training steps",
    type_map: "Atom types",
    training_data: "Training datasets",
    validation_data: "Validation datasets",
    fitting_net: "Fitting network",
    start_lr: "Starting learning rate",
    stop_lr: "Final learning rate",
  };
  if (special[name]) return special[name];
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
