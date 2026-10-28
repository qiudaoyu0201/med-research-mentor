import { useEffect, type RefObject } from "react";

export function useDialogFocus(
  reference: RefObject<HTMLDialogElement | null>,
  open: boolean,
) {
  useEffect(() => {
    if (!open || !reference.current) return;
    const dialog = reference.current;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => {
      dialog.close();
      requestAnimationFrame(() => {
        if (
          trigger instanceof HTMLElement &&
          trigger.isConnected &&
          !document.querySelector("dialog[open]")
        )
          trigger.focus({ preventScroll: true });
      });
    };
  }, [reference, open]);
}
