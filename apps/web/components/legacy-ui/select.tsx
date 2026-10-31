"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

type Props = {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    id?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    "aria-label"?: string;
    className?: string;
    /** Trigger height: `sm` for toolbars, default for forms. */
    size?: "sm" | "md";
};

/**
 * Select primitive: a button that opens a listbox, replacing the native
 * `<select>`. Arrow keys, Home/End, Enter, Escape and type-ahead work; the
 * list is portalled so dialogs and scroll areas never clip it.
 */
export function Select({ value, onChange, options, id, disabled, autoFocus, className, size = "md", ...rest }: Props) {
    const [open, setOpen] = React.useState(false);
    const [active, setActive] = React.useState(0);
    const [rect, setRect] = React.useState<{
        left: number;
        right: number;
        top: number;
        width: number;
        up: boolean;
        alignRight: boolean;
    } | null>(null);
    const trigger = React.useRef<HTMLButtonElement>(null);
    const list = React.useRef<HTMLUListElement>(null);
    const typed = React.useRef({ text: "", at: 0 });
    const listId = React.useId();

    const selectedIndex = Math.max(
        0,
        options.findIndex((o) => o.value === value)
    );
    const current = options.find((o) => o.value === value);

    const openList = () => {
        if (disabled || !trigger.current) {
            return;
        }
        const r = trigger.current.getBoundingClientRect();
        const below = window.innerHeight - r.bottom;
        const up = below < 220 && r.top > below;
        setRect({
            left: r.left,
            right: window.innerWidth - r.right,
            top: up ? r.top : r.bottom,
            width: r.width,
            up,
            alignRight: r.left + r.width / 2 > window.innerWidth / 2,
        });
        setActive(selectedIndex);
        setOpen(true);
    };
    const close = React.useCallback((refocus = true) => {
        setOpen(false);
        if (refocus) {
            trigger.current?.focus();
        }
    }, []);
    const choose = (index: number) => {
        const option = options[index];
        if (option) {
            onChange(option.value);
        }
        close();
    };

    React.useEffect(() => {
        if (!open) {
            return;
        }
        const onPointer = (event: PointerEvent) => {
            const target = event.target as Node;
            if (!list.current?.contains(target) && !trigger.current?.contains(target)) {
                close(false);
            }
        };
        const onScroll = (event: Event) => {
            if (!list.current?.contains(event.target as Node)) {
                close(false);
            }
        };
        window.addEventListener("pointerdown", onPointer);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
        return () => {
            window.removeEventListener("pointerdown", onPointer);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onScroll);
        };
    }, [open, close]);

    React.useEffect(() => {
        if (open) {
            list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
        }
    }, [open, active]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        const last = options.length - 1;
        if (!open) {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                openList();
            }
            return;
        }
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                setActive((i) => Math.min(last, i + 1));
                break;
            case "ArrowUp":
                event.preventDefault();
                setActive((i) => Math.max(0, i - 1));
                break;
            case "Home":
                event.preventDefault();
                setActive(0);
                break;
            case "End":
                event.preventDefault();
                setActive(last);
                break;
            case "Enter":
            case " ":
                event.preventDefault();
                choose(active);
                break;
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                close();
                break;
            case "Tab":
                close(false);
                break;
            default:
                if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                    const now = Date.now();
                    typed.current.text =
                        (now - typed.current.at > 700 ? "" : typed.current.text) + event.key.toLowerCase();
                    typed.current.at = now;
                    const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
                    if (hit >= 0) {
                        setActive(hit);
                    }
                }
        }
    };

    return (
        <>
            <button
                ref={trigger}
                type="button"
                id={id}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={rest["aria-label"]}
                disabled={disabled}
                autoFocus={autoFocus}
                onClick={() => (open ? close() : openList())}
                onKeyDown={onKeyDown}
                className={cn("ui-select", size === "sm" && "ui-select-sm", className)}
            >
                <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? ""}</span>
                <svg
                    viewBox="0 0 12 12"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="ui-select-chevron"
                >
                    <path d="m3 4.5 3 3 3-3" />
                </svg>
            </button>
            {open && rect
                ? createPortal(
                      <ul
                          ref={list}
                          id={listId}
                          role="listbox"
                          className="ui-select-list"
                          style={{
                              ...(rect.alignRight ? { right: rect.right } : { left: rect.left }),
                              minWidth: rect.width,
                              ...(rect.up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top + 4 }),
                          }}
                      >
                          {options.map((option, index) => (
                              <li
                                  key={option.value}
                                  role="option"
                                  aria-selected={option.value === value}
                                  data-index={index}
                                  data-active={index === active || undefined}
                                  onPointerEnter={() => setActive(index)}
                                  onClick={() => choose(index)}
                                  className="ui-select-option"
                              >
                                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                  {option.value === value ? (
                                      <svg
                                          viewBox="0 0 12 12"
                                          width="12"
                                          height="12"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          aria-hidden
                                      >
                                          <path d="M2.5 6.2 5 8.7l4.5-5" />
                                      </svg>
                                  ) : null}
                              </li>
                          ))}
                      </ul>,
                      document.body
                  )
                : null}
        </>
    );
}
