import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";
import { actionIcon, ResearchIcon } from "./research-icons.tsx";

export type ObjectAction = {
  label: string;
  run?: () => void;
  disabled?: boolean;
  children?: ObjectAction[];
};

// Both entry points capture the same actions for the same mounted object.
export function ObjectMenu({
  label,
  actions,
  children,
  objectKey,
}: {
  label: string;
  actions: ObjectAction[];
  children?: ReactNode;
  objectKey: string;
}) {
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const [submenu, setSubmenu] = useState<ObjectAction[]>();
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const captured = useRef(actions);
  function close() {
    setPosition(undefined);
    setSubmenu(undefined);
    trigger.current?.focus({ preventScroll: true });
  }
  function open(x: number, y: number) {
    captured.current = actions;
    setSubmenu(undefined);
    setPosition({ x, y });
  }
  useEffect(() => {
    setPosition(undefined);
    setSubmenu(undefined);
  }, [objectKey]);
  useEffect(() => {
    if (!position) return;
    const outside = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close();
    };
    const hide = () => {
      setPosition(undefined);
      setSubmenu(undefined);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("research-dismiss-menus", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("research-dismiss-menus", hide);
      window.removeEventListener("resize", hide);
    };
  }, [position]);
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const target = menu.current,
      box = target.getBoundingClientRect();
    target.style.left = `${Math.max(8, Math.min(position.x, innerWidth - box.width - 8))}px`;
    target.style.top = `${Math.max(8, Math.min(position.y, innerHeight - box.height - 8))}px`;
    target.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [position, submenu]);
  return (
    <div
      className="rw-object"
      onContextMenu={(e) => {
        if (!actions.length) return;
        if (
          (e.target as HTMLElement).closest(
            "input,textarea,[contenteditable],.rw-selectable,.textLayer",
          ) ||
          window.getSelection()?.toString()
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("research-dismiss-menus"));
        open(e.clientX, e.clientY);
      }}
    >
      {children}
      {!!actions.length && (
        <button
          ref={trigger}
          type="button"
          className="rw-more"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={!!position}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (position) close();
            else {
              window.dispatchEvent(new Event("research-dismiss-menus"));
              const box = trigger.current!.getBoundingClientRect();
              open(box.left, box.bottom + 4);
            }
          }}
        >
          <ResearchIcon name={label === "添加附件" ? "plus" : "more"} />
        </button>
      )}
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            className="rw-object-menu"
            style={{ left: position.x, top: position.y }}
            onKeyDown={(e) => {
              e.stopPropagation();
              const buttons = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ];
              const i = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                buttons[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (i +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length
                ]?.focus();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
              if (e.key === "ArrowLeft" && submenu) {
                e.preventDefault();
                setSubmenu(undefined);
              }
            }}
          >
            {submenu && (
              <button role="menuitem" onClick={() => setSubmenu(undefined)}>
                ‹ 返回
              </button>
            )}
            {(submenu ?? captured.current).map((action, index) => (
              <button
                key={`${action.label}:${index}`}
                role="menuitem"
                disabled={action.disabled}
                aria-haspopup={action.children ? "menu" : undefined}
                onClick={() => {
                  if (action.children) setSubmenu(action.children);
                  else {
                    close();
                    action.run?.();
                  }
                }}
              >
                <ResearchIcon name={actionIcon(action.label)} />
                <span>{action.label}</span>
                {action.children && <ResearchIcon name="chevron" />}
              </button>
            ))}
          </div>,
          document.querySelector(".rw") ?? document.body,
        )}
    </div>
  );
}

export function SelectionActions({
  text,
  explain,
  cite,
  source,
}: {
  text: string;
  explain: () => void;
  cite: () => void;
  source?: () => void;
}) {
  function finish(action: () => void) {
    action();
    window.getSelection()?.removeAllRanges();
  }
  return (
    <div
      className="rw-selection-actions"
      role="toolbar"
      aria-label="所选文字操作"
      onPointerDown={(e) => e.preventDefault()}
    >
      <button type="button" onClick={() => finish(explain)}>
        解释
      </button>
      <button type="button" onClick={() => finish(cite)}>
        引用
      </button>
      <ObjectMenu
        objectKey={text}
        label="选区更多操作"
        actions={[
          {
            label: "复制",
            run: () => void navigator.clipboard.writeText(text),
          },
          ...(source ? [{ label: "查看来源", run: source }] : []),
        ]}
      />
    </div>
  );
}
