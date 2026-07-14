// SPDX-License-Identifier: LGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { Workflow } from "../types";
import { buildArguments, quoteArgument, splitCommandLine } from "./arguments";

const nestedWorkflow: Workflow = {
  name: "pretrained",
  usage: "dp pretrained download MODEL",
  category: "Models",
  title: "Pretrained models",
  description: "Download a pretrained model.",
  icon: "library",
  accent: "orange",
  arguments: [
    {
      id: "pretrained_command",
      flags: [],
      positional: true,
      required: true,
      kind: "select",
      nargs: null,
      default: null,
      choices: ["download"],
      help: "Choose an action.",
      metavar: null,
      mutex_group: null,
      condition: null,
    },
    {
      id: "MODEL",
      flags: [],
      positional: true,
      required: true,
      kind: "text",
      nargs: null,
      default: null,
      choices: [],
      help: "Model identifier.",
      metavar: null,
      mutex_group: null,
      condition: { field: "pretrained_command", equals: "download" },
    },
  ],
};

describe("argument generation", () => {
  it("preserves Windows paths in raw arguments", () => {
    expect(splitCommandLine('--model "C:\\Models\\water model.pth"')).toEqual([
      "--model",
      "C:\\Models\\water model.pth",
    ]);
    expect(quoteArgument("C:\\Models\\water model.pth")).toBe(
      '"C:\\Models\\water model.pth"',
    );
  });

  it("emits only the selected nested command fields", () => {
    const beforeSelection = buildArguments(
      nestedWorkflow,
      { pretrained_command: "", MODEL: "" },
      new Set(),
      "",
    );
    expect(beforeSelection.missing).toEqual(["Pretrained Command"]);

    const selected = buildArguments(
      nestedWorkflow,
      { pretrained_command: "download", MODEL: "" },
      new Set(["pretrained_command"]),
      "",
    );
    expect(selected.args).toEqual(["download"]);
    expect(selected.missing).toEqual(["MODEL"]);

    const complete = buildArguments(
      nestedWorkflow,
      { pretrained_command: "download", MODEL: "DPA-3.1" },
      new Set(["pretrained_command", "MODEL"]),
      "",
    );
    expect(complete).toEqual({ args: ["download", "DPA-3.1"], missing: [] });
  });
});
