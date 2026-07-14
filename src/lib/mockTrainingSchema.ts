// SPDX-License-Identifier: LGPL-3.0-or-later

import type { InputArgument, InputVariant, JsonValue, TrainingInputSchema } from "../types";

function field(
  name: string,
  type: string[],
  doc: string,
  options: { optional?: boolean; default?: JsonValue; subFields?: InputArgument[]; variants?: InputVariant[] } = {},
): InputArgument {
  return {
    object: "Argument",
    name,
    type,
    optional: options.optional ?? true,
    alias: [],
    doc,
    repeat: false,
    sub_fields: Object.fromEntries((options.subFields ?? []).map((item) => [item.name, item])),
    sub_variants: Object.fromEntries((options.variants ?? []).map((item) => [item.flag_name, item])),
    ...(Object.hasOwn(options, "default") ? { default: options.default } : {}),
  };
}

function variant(flagName: string, defaultTag: string, choices: InputArgument[]): InputVariant {
  return {
    object: "Variant",
    flag_name: flagName,
    optional: Boolean(defaultTag),
    default_tag: defaultTag,
    choice_dict: Object.fromEntries(choices.map((choice) => [choice.name, choice])),
  };
}

const descriptorDpa4 = field("dpa4", ["dict"], "DPA4 equivariant descriptor.", {
  optional: false,
  subFields: [
    field("rcut", ["float"], "Cut-off radius.", { default: 6.0 }),
    field("sel", ["int", "str"], "Selected neighbor count or automatic selection.", { default: 256 }),
    field("n_dim", ["int"], "Internal feature dimension.", { default: 128 }),
    field("n_layers", ["int"], "Number of DPA4 blocks.", { default: 4 }),
  ],
});
const fittingDpa4 = field("dpa4_ener", ["dict"], "DPA4 energy fitting network.", {
  optional: false,
  subFields: [
    field("neuron", ["list"], "Hidden layer widths.", { default: [240, 240, 240] }),
    field("precision", ["str"], "Parameter precision.", { default: "float32" }),
  ],
});
const standardModel = field("standard", ["dict"], "Standard DeePMD model.", {
  optional: false,
  subFields: [
    field("descriptor", ["dict"], "Descriptor configuration.", {
      optional: false,
      variants: [variant("type", "", [
        field("se_e2_a", ["dict"], "Smooth edition angular descriptor.", { optional: false }),
        descriptorDpa4,
      ])],
    }),
    field("fitting_net", ["dict"], "Fitting network configuration.", {
      optional: false,
      variants: [variant("type", "ener", [field("ener", ["dict"], "Energy fitting network.", { optional: false })])],
    }),
  ],
});
const dpa4Model = field("dpa4", ["dict"], "DPA4 / SeZM model.", {
  optional: false,
  subFields: [
    field("descriptor", ["dict"], "DPA4 descriptor configuration.", {
      optional: false,
      variants: [variant("type", "dpa4", [descriptorDpa4])],
    }),
    field("fitting_net", ["dict"], "DPA4 fitting network.", {
      optional: false,
      variants: [variant("type", "dpa4_ener", [fittingDpa4])],
    }),
    field("use_compile", ["bool"], "Use torch.compile for supported DPA4 workloads.", { default: false }),
    field("enable_tf32", ["bool"], "Enable TF32 matrix multiplication on CUDA.", { default: true }),
  ],
});

export const mockTrainingSchema: TrainingInputSchema = {
  schema_version: 1,
  deepmd_version: "3.1.4.dev",
  arguments: [
    field("model", ["dict"], "Model definition.", {
      optional: false,
      subFields: [field("type_map", ["list"], "Names of atom types.")],
      variants: [variant("type", "standard", [standardModel, dpa4Model])],
    }),
    field("learning_rate", ["dict"], "Learning-rate schedule.", {
      variants: [variant("type", "exp", [
        field("exp", ["dict"], "Exponential schedule.", {
          optional: false,
          subFields: [
            field("start_lr", ["float"], "Starting learning rate.", { default: 0.001 }),
            field("stop_lr", ["float"], "Final learning rate.", { default: 1e-8 }),
            field("decay_steps", ["int"], "Decay interval.", { default: 5000 }),
          ],
        }),
      ])],
    }),
    field("optimizer", ["dict"], "Optimizer.", {
      variants: [variant("type", "Adam", [
        field("Adam", ["dict"], "Adam optimizer.", { optional: false }),
        field("AdamW", ["dict"], "AdamW optimizer.", {
          optional: false,
          subFields: [field("weight_decay", ["float"], "Weight decay.", { default: 0.01 })],
        }),
      ])],
    }),
    field("loss", ["dict"], "Training loss.", {
      variants: [variant("type", "ener", [field("ener", ["dict"], "Energy/force/virial loss.", { optional: false })])],
    }),
    field("training", ["dict"], "Data and training loop.", {
      optional: false,
      subFields: [
        field("training_data", ["dict"], "Training datasets.", {
          optional: false,
          subFields: [
            field("systems", ["str", "list"], "Training system folders.", { optional: false, default: "." }),
            field("batch_size", ["str", "int", "list"], "Batch size for each system.", { default: "auto" }),
          ],
        }),
        field("validation_data", ["dict", "NoneType"], "Validation datasets.", {
          default: null,
          subFields: [field("systems", ["str", "list"], "Validation system folders.", { optional: false })],
        }),
        field("numb_steps", ["int"], "Number of optimization steps.", { default: 1_000_000 }),
        field("seed", ["int", "NoneType"], "Training random seed.", { default: null }),
        field("disp_freq", ["int"], "Training log interval.", { default: 1000 }),
        field("save_freq", ["int"], "Checkpoint interval.", { default: 10000 }),
      ],
    }),
    field("validating", ["dict"], "Full validation settings.", { default: {} }),
  ],
};
