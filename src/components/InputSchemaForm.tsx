// SPDX-License-Identifier: LGPL-3.0-or-later

import { Check, ChevronDown, FolderPlus, Info, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  COMMON_INPUT_FIELDS,
  activeFields,
  changeVariant,
  displayName,
  initializeValue,
  isObject,
} from "../lib/inputBuilder";
import { chooseSystemDirectories } from "../lib/studio";
import type { InputArgument, JsonScalar, JsonValue } from "../types";

interface InputSchemaFormProps {
  argument: InputArgument;
  value: Record<string, JsonValue>;
  onChange: (value: Record<string, JsonValue>) => void;
  path?: string;
}

function defaultLabel(argument: InputArgument): string | null {
  if (!Object.hasOwn(argument, "default")) return null;
  const value = argument.default;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Doc({ text }: { text: string }) {
  if (!text) return null;
  const concise = text.replace(/\s+/g, " ").trim();
  if (concise.length <= 220) return <p className="schema-doc">{concise}</p>;
  return (
    <details className="schema-doc-details">
      <summary>{concise.slice(0, 205).trim()}… <span>More</span></summary>
      <p>{text}</p>
    </details>
  );
}

function inferListEntry(raw: string): JsonValue {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number.parseFloat(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function choiceKey(value: JsonScalar): string {
  return JSON.stringify(value);
}

function choiceLabel(value: JsonScalar): string {
  return value === null ? "null" : String(value);
}

interface DropdownOption {
  label: string;
  value: string;
}

interface ChoiceDropdownProps {
  ariaLabel: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  value: string;
}

function ChoiceDropdown({ ariaLabel, onChange, options, value }: ChoiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuStyle, setMenuStyle] = useState<Record<string, string | number>>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return undefined;

    function positionMenu(): void {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 7;
      const edge = 12;
      const roomBelow = window.innerHeight - rect.bottom - edge - gap;
      const roomAbove = rect.top - edge - gap;
      const above = roomBelow < 180 && roomAbove > roomBelow;
      const available = Math.max(112, above ? roomAbove : roomBelow);
      setMenuStyle({
        bottom: above ? window.innerHeight - rect.top + gap : "auto",
        left: Math.max(edge, Math.min(rect.left, window.innerWidth - rect.width - edge)),
        maxHeight: Math.min(280, available),
        top: above ? "auto" : rect.bottom + gap,
        width: rect.width,
      });
    }

    function closeOutside(event: PointerEvent): void {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }

    positionMenu();
    setHighlighted(selectedIndex);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, selectedIndex]);

  function choose(index: number): void {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(highlighted);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="choice-dropdown">
      <button
        ref={buttonRef}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="choice-dropdown-trigger"
        role="combobox"
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown className={open ? "open" : ""} size={16} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="choice-dropdown-menu" id={listboxId} role="listbox" style={menuStyle}>
          {options.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className={`choice-dropdown-option${index === highlighted ? " highlighted" : ""}`}
              key={option.value}
              role="option"
              type="button"
              onClick={() => choose(index)}
              onMouseEnter={() => setHighlighted(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function JsonEditor({ value, onChange }: { value: JsonValue; onChange: (value: JsonValue) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);

  function update(next: string): void {
    setText(next);
    try {
      onChange(JSON.parse(next) as JsonValue);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="schema-json-editor">
      <textarea rows={Math.min(12, Math.max(4, text.split(/\r?\n/).length))} value={text} onChange={(event) => update(event.target.value)} />
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}

function SystemsEditor({ value, onChange }: { value: JsonValue; onChange: (value: JsonValue) => void }) {
  const systems = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];

  async function browse(): Promise<void> {
    const selected = await chooseSystemDirectories();
    if (selected.length) onChange([...new Set([...systems.filter((item) => item !== "."), ...selected])]);
  }

  function update(index: number, next: string): void {
    onChange(systems.map((item, itemIndex) => itemIndex === index ? next : item));
  }

  return (
    <div className="systems-editor">
      {systems.map((system, index) => (
        <div className="system-path-row" key={index}>
          <input value={system} onChange={(event) => update(index, event.target.value)} />
          <button className="icon-button" type="button" title="Remove dataset" onClick={() => onChange(systems.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="schema-add-button" type="button" onClick={() => void browse()}><FolderPlus size={15} /> Choose dataset folders</button>
    </div>
  );
}

interface SchemaFieldProps {
  argument: InputArgument;
  parent: Record<string, JsonValue>;
  onParent: (value: Record<string, JsonValue>) => void;
  path: string;
}

function SchemaField({ argument, parent, onParent, path }: SchemaFieldProps) {
  const included = Object.hasOwn(parent, argument.name);
  const value = parent[argument.name];
  const label = displayName(argument.name);
  const fallback = defaultLabel(argument);
  const structured = argument.type.includes("dict") && (
    Object.keys(argument.sub_fields).length > 0 || Object.keys(argument.sub_variants).length > 0
  );

  function setValue(next: JsonValue): void {
    onParent({ ...parent, [argument.name]: next });
  }

  function remove(): void {
    const next = { ...parent };
    delete next[argument.name];
    onParent(next);
  }

  if (!included) {
    return (
      <button className="schema-optional-row" type="button" onClick={() => setValue(initializeValue(argument))}>
        <span className="schema-optional-plus"><Plus size={14} /></span>
        <span><strong>{label}</strong><small>{argument.doc.replace(/\s+/g, " ").slice(0, 120) || "Optional setting"}</small></span>
        {fallback !== null && <code>default {fallback}</code>}
      </button>
    );
  }

  if (structured) {
    const objectValue = isObject(value) ? value : {};
    return (
      <section className="schema-object-card">
        <header>
          <div><strong>{label}</strong>{!argument.optional && <span className="required-pill">Required</span>}</div>
          {argument.optional && <button className="icon-button" type="button" onClick={remove} title={`Remove ${label}`}><X size={14} /></button>}
        </header>
        <Doc text={argument.doc} />
        <InputObjectFields argument={argument} value={objectValue} onChange={setValue} path={path} />
      </section>
    );
  }

  const isBoolean = argument.type.includes("bool") && typeof value === "boolean";
  const isList = argument.type.includes("list") && Array.isArray(value);
  const isNumber = typeof value === "number" || (
    !argument.type.includes("str") && argument.type.some((type) => type === "int" || type === "float")
  );
  const isSystems = argument.name === "systems";
  const choices = argument.choices ?? [];
  const isChoice = choices.length > 0 && (
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
  const selectedChoice = isChoice ? choiceKey(value as JsonScalar) : "";
  const hasCustomChoice = isChoice && !choices.some((choice) => choiceKey(choice) === selectedChoice);

  return (
    <div className="schema-field">
      <div className="schema-field-heading">
        <div><strong>{label}</strong>{!argument.optional && <span className="required-pill">Required</span>}{fallback !== null && <code>default {fallback}</code>}</div>
        {argument.optional && <button className="schema-reset" type="button" onClick={remove} title="Use the DeePMD default"><RotateCcw size={13} /> Default</button>}
      </div>
      <Doc text={argument.doc} />
      {isSystems ? (
        <SystemsEditor value={value} onChange={setValue} />
      ) : isChoice ? (
        <ChoiceDropdown
          ariaLabel={label}
          value={selectedChoice}
          options={[
            ...(hasCustomChoice ? [{ value: selectedChoice, label: `${choiceLabel(value as JsonScalar)} · custom` }] : []),
            ...choices.map((choice) => ({ value: choiceKey(choice), label: choiceLabel(choice) })),
          ]}
          onChange={(next) => {
            const selected = choices.find((choice) => choiceKey(choice) === next);
            if (selected !== undefined) setValue(selected);
          }}
        />
      ) : isBoolean ? (
        <label className="schema-switch">
          <input type="checkbox" checked={value} onChange={(event) => setValue(event.target.checked)} />
          <span aria-hidden="true"><i /></span>
          <em>{value ? "Enabled" : "Disabled"}</em>
        </label>
      ) : isList ? (
        <textarea
          className="schema-list-input"
          rows={Math.max(3, value.length)}
          value={value.map(String).join("\n")}
          onChange={(event) => setValue(event.target.value.split(/\r?\n/).filter((item) => item.trim()).map(inferListEntry))}
          placeholder="One value per line"
        />
      ) : isNumber ? (
        <input
          className="schema-input"
          type="number"
          step={argument.type.includes("int") ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const raw = event.target.value;
            setValue(raw === "" ? "" : argument.type.includes("int") ? Number.parseInt(raw, 10) : Number.parseFloat(raw));
          }}
        />
      ) : typeof value === "string" ? (
        <input className="schema-input" value={value} onChange={(event) => setValue(event.target.value)} />
      ) : (
        <JsonEditor value={value ?? null} onChange={setValue} />
      )}
    </div>
  );
}

function InputObjectFields({ argument, value, onChange, path }: InputSchemaFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const fields = useMemo(() => activeFields(argument, value), [argument, value]);
  const primary = fields.filter((field) => !field.optional || COMMON_INPUT_FIELDS.has(field.name) || Object.hasOwn(value, field.name));
  const advanced = fields.filter((field) => !primary.includes(field));
  const normalizedQuery = query.trim().toLowerCase();
  const searched = normalizedQuery
    ? advanced.filter((field) => `${field.name} ${field.doc}`.toLowerCase().includes(normalizedQuery))
    : [];

  return (
    <div className="schema-object-fields">
      {Object.values(argument.sub_variants).map((variant) => {
        const selected = typeof value[variant.flag_name] === "string" ? String(value[variant.flag_name]) : variant.default_tag;
        return (
          <div className="schema-variant" key={variant.flag_name}>
            <span><strong>{displayName(variant.flag_name)}</strong><small>Controls the available settings below</small></span>
            <ChoiceDropdown
              ariaLabel={displayName(variant.flag_name)}
              value={selected}
              options={[
                ...(!selected ? [{ value: "", label: "Choose…" }] : []),
                ...Object.entries(variant.choice_dict).map(([tag, choice]) => ({
                  value: tag,
                  label: `${displayName(tag)}${choice.alias.length ? ` · ${choice.alias.join(", ")}` : ""}`,
                })),
              ]}
              onChange={(next) => onChange(changeVariant(argument, value, variant, next))}
            />
          </div>
        );
      })}

      <div className="schema-fields-list">
        {primary.map((field) => (
          <SchemaField key={field.name} argument={field} parent={value} onParent={onChange} path={`${path}.${field.name}`} />
        ))}
      </div>

      {advanced.length > 0 && (
        <section className="schema-advanced">
          <button className="schema-advanced-toggle" type="button" onClick={() => setShowAdvanced((current) => !current)}>
            <span><Info size={15} /><strong>Advanced options</strong><small>{advanced.length} additional training settings</small></span>
            <ChevronDown className={showAdvanced ? "" : "collapsed"} size={16} />
          </button>
          {showAdvanced && (
            <div className="schema-advanced-body">
              <label className="schema-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this section" /></label>
              <div className="schema-fields-list">
                {(normalizedQuery ? searched : advanced).map((field) => (
                  <SchemaField key={field.name} argument={field} parent={value} onParent={onChange} path={`${path}.${field.name}`} />
                ))}
                {normalizedQuery && searched.length === 0 && <p className="empty-inline">No training option matches “{query}”.</p>}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function InputSchemaForm({ argument, value, onChange, path = argument.name }: InputSchemaFormProps) {
  return <InputObjectFields argument={argument} value={value} onChange={onChange} path={path} />;
}
