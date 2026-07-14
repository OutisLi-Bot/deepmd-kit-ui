// SPDX-License-Identifier: LGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { mockTrainingSchema } from "./mockTrainingSchema";
import {
  changeVariant,
  collectMissing,
  compactInput,
  createTrainingDraft,
  isObject,
} from "./inputBuilder";

describe("training input builder", () => {
  it("starts with a usable data loop and optimizer schedule", () => {
    const draft = createTrainingDraft(mockTrainingSchema);
    expect(draft.training).toMatchObject({
      training_data: { systems: "." },
      numb_steps: 1_000_000,
    });
    expect(draft.learning_rate).toMatchObject({ type: "exp", start_lr: 0.001 });
    expect(draft.optimizer).toMatchObject({ type: "Adam" });
  });

  it("tracks active argcheck variants and required fields", () => {
    const draft = createTrainingDraft(mockTrainingSchema);
    const modelArgument = mockTrainingSchema.arguments.find((argument) => argument.name === "model")!;
    expect(collectMissing(modelArgument, draft.model)).toContain("model.descriptor.type");

    const model = isObject(draft.model) ? draft.model : {};
    const switched = changeVariant(modelArgument, model, modelArgument.sub_variants.type, "dpa4");
    expect(switched).toMatchObject({
      type: "dpa4",
      descriptor: { type: "dpa4" },
      fitting_net: { type: "dpa4_ener" },
    });
    expect(collectMissing(modelArgument, switched)).toEqual([]);
  });

  it("removes empty editor placeholders before saving", () => {
    expect(compactInput({ model: { type: "dpa4", note: "" }, empty: "" })).toEqual({
      model: { type: "dpa4" },
    });
  });
});
