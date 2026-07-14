// SPDX-License-Identifier: LGPL-3.0-or-later

import { ChevronDown, FolderOpen, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fieldLabel, isMultiple } from "../lib/arguments";
import { chooseInputPath, chooseOutputPath } from "../lib/studio";
import type { CatalogArgument, FieldValue, Workflow } from "../types";

interface CommandFormProps {
  workflow: Workflow;
  values: Record<string, FieldValue>;
  touched: ReadonlySet<string>;
  onChange: (argument: CatalogArgument, value: FieldValue) => void;
  onReset: () => void;
}

function isAdvanced(argument: CatalogArgument): boolean {
  return (
    argument.id === "log_level" ||
    argument.id === "log_path" ||
    argument.id === "mpi_log" ||
    argument.help.length > 220
  );
}

function pathUsesDirectory(argument: CatalogArgument): boolean {
  const id = argument.id.toLowerCase();
  return id.includes("directory") || id.includes("folder") || id === "system";
}

function pathUsesSaveDialog(argument: CatalogArgument): boolean {
  const id = argument.id.toLowerCase();
  return id.includes("output") || id === "log_path" || id === "output_model";
}

interface FieldProps {
  argument: CatalogArgument;
  value: FieldValue;
  touched: boolean;
  onChange: (value: FieldValue) => void;
}

function Field({ argument, value, touched, onChange }: FieldProps) {
  const label = fieldLabel(argument);
  const fieldId = `field-${argument.id}`;

  async function browse(): Promise<void> {
    const result = pathUsesSaveDialog(argument)
      ? await chooseOutputPath(typeof value === "string" ? value : undefined)
      : await chooseInputPath(pathUsesDirectory(argument));
    if (result) onChange(result);
  }

  if (argument.kind === "boolean") {
    return (
      <label className="toggle-field" htmlFor={fieldId}>
        <span className="toggle-copy">
          <span className="field-title-row">
            <strong>{label}</strong>
            {argument.required && <span className="required-pill">Required</span>}
          </span>
          {argument.help && <small>{argument.help}</small>}
        </span>
        <input
          id={fieldId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-track" aria-hidden="true"><span /></span>
      </label>
    );
  }

  const commonProps = {
    id: fieldId,
    value: String(value),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };
  const placeholder = argument.default == null
    ? argument.metavar == null
      ? ""
      : String(argument.metavar)
    : `Default: ${Array.isArray(argument.default) ? argument.default.join(", ") : argument.default}`;

  return (
    <div className="form-field">
      <label className="field-title-row" htmlFor={fieldId}>
        <strong>{label}</strong>
        {argument.required && <span className="required-pill">Required</span>}
        {argument.mutex_group && <span className="choice-pill">Exclusive choice</span>}
      </label>
      {argument.help && <p className="field-help">{argument.help}</p>}
      <div className="field-control-row">
        {argument.kind === "select" && !isMultiple(argument) ? (
          <div className="select-wrap">
            <select {...commonProps}>
              {argument.default == null && (
                <option value="">{argument.required ? "Select…" : "Not set"}</option>
              )}
              {argument.choices.map((choice) => (
                <option key={String(choice)} value={String(choice)}>{String(choice)}</option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </div>
        ) : isMultiple(argument) ? (
          <textarea
            {...commonProps}
            rows={Math.max(3, String(value).split(/\r?\n/).length)}
            placeholder="One value per line"
          />
        ) : (
          <input
            {...commonProps}
            type={argument.kind === "integer" || argument.kind === "number" ? "number" : "text"}
            step={argument.kind === "integer" ? 1 : argument.kind === "number" ? "any" : undefined}
            placeholder={placeholder}
            className={touched ? "touched" : ""}
          />
        )}
        {argument.kind === "path" && (
          <button className="icon-button browse-button" type="button" onClick={browse} title="Browse">
            <FolderOpen aria-hidden="true" size={17} />
          </button>
        )}
      </div>
      <code className="field-flag">{argument.positional ? "positional" : argument.flags.join(", ")}</code>
    </div>
  );
}

export function CommandForm({ workflow, values, touched, onChange, onReset }: CommandFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => setShowAdvanced(false), [workflow.name]);

  const { primary, advanced } = useMemo(() => {
    const visible = workflow.arguments.filter(
      (argument) =>
        !argument.condition ||
        String(values[argument.condition.field] ?? "") === argument.condition.equals,
    );
    const primaryFields = visible.filter((argument) => !isAdvanced(argument));
    const advancedFields = visible.filter(isAdvanced);
    return { primary: primaryFields, advanced: advancedFields };
  }, [values, workflow]);

  return (
    <div className="command-form">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Command parameters</p>
          <h2>Configure workflow</h2>
        </div>
        <button className="text-button" type="button" onClick={onReset}>
          <RotateCcw aria-hidden="true" size={14} /> Reset
        </button>
      </div>

      <div className="form-stack">
        {primary.map((argument) => (
          <Field
            argument={argument}
            key={argument.id}
            value={values[argument.id] ?? ""}
            touched={touched.has(argument.id)}
            onChange={(value) => onChange(argument, value)}
          />
        ))}
      </div>

      {advanced.length > 0 && (
        <div className="advanced-section">
          <button
            className="advanced-toggle"
            type="button"
            onClick={() => setShowAdvanced((current) => !current)}
            aria-expanded={showAdvanced}
          >
            <span>
              Advanced & logging
              <small>{advanced.length} parameters</small>
            </span>
            <ChevronDown className={showAdvanced ? "" : "collapsed"} size={17} />
          </button>
          {showAdvanced && (
            <div className="form-stack advanced-fields">
              {advanced.map((argument) => (
                <Field
                  argument={argument}
                  key={argument.id}
                  value={values[argument.id] ?? ""}
                  touched={touched.has(argument.id)}
                  onChange={(value) => onChange(argument, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
