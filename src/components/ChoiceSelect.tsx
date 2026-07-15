// SPDX-License-Identifier: LGPL-3.0-or-later

import { Check, ChevronDown } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface ChoiceSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface ChoiceSelectProps {
  ariaLabel: string;
  value: string;
  options: ChoiceSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** Render one theme-aware, keyboard-accessible application select. */
export function ChoiceSelect({
  ariaLabel,
  value,
  options,
  onChange,
  className = "",
  disabled = false,
  placeholder = "Choose…",
}: ChoiceSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabledIndices = useMemo(
    () => options.flatMap((option, index) => option.disabled ? [] : [index]),
    [options],
  );

  useEffect(() => {
    if (!open) return undefined;

    function positionMenu(): void {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 7;
      const edge = 12;
      const width = Math.min(rect.width, window.innerWidth - edge * 2);
      const roomBelow = window.innerHeight - rect.bottom - edge - gap;
      const roomAbove = rect.top - edge - gap;
      const above = roomBelow < 180 && roomAbove > roomBelow;
      const available = Math.max(112, above ? roomAbove : roomBelow);
      setMenuStyle({
        bottom: above ? window.innerHeight - rect.top + gap : "auto",
        left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)),
        maxHeight: Math.min(320, available),
        top: above ? "auto" : rect.bottom + gap,
        width,
      });
    }

    function closeOutside(event: PointerEvent): void {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    positionMenu();
    setHighlighted(selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : enabledIndices[0] ?? 0);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [enabledIndices, open, options, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function moveHighlight(direction: 1 | -1): void {
    if (!enabledIndices.length) return;
    const current = enabledIndices.indexOf(highlighted);
    const start = current >= 0 ? current : 0;
    const next = (start + direction + enabledIndices.length) % enabledIndices.length;
    setHighlighted(enabledIndices[next]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(highlighted);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  return (
    <div className={`choice-dropdown${className ? ` ${className}` : ""}`}>
      <button
        ref={buttonRef}
        aria-activedescendant={open ? optionId(highlighted) : undefined}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="choice-dropdown-trigger"
        disabled={disabled}
        role="combobox"
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className={!selected ? "placeholder" : undefined}>{selected?.label ?? placeholder}</span>
        <ChevronDown className={open ? "open" : ""} size={16} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="choice-dropdown-menu" id={listboxId} role="listbox" style={menuStyle}>
          {options.map((option, index) => (
            <button
              aria-disabled={option.disabled || undefined}
              aria-selected={option.value === value}
              className={`choice-dropdown-option${index === highlighted ? " highlighted" : ""}`}
              data-option-index={index}
              disabled={option.disabled}
              id={optionId(index)}
              key={option.value}
              role="option"
              type="button"
              onClick={() => choose(index)}
              onMouseEnter={() => !option.disabled && setHighlighted(index)}
            >
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
