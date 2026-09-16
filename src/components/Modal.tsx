"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog (Phase 4 accessibility).
 *
 * A plain overlay div is unusable without a mouse, so this adds the three
 * things assistive tech and keyboard users need: the dialog is announced as a
 * dialog, Escape closes it, and focus is moved in on open, trapped while open,
 * and returned to the trigger on close — otherwise a screen-reader user is
 * silently left reading the page behind the modal.
 */
export function Modal({
  onClose,
  width = 500,
  label,
  children,
}: {
  onClose: () => void;
  width?: number;
  /** Accessible name for the dialog, announced on open. */
  label: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Callers overwhelmingly pass an inline `() => setX(false)`, a fresh
  // function every render -- if the effect below depended on `onClose`
  // directly, typing into any field inside the modal (which re-renders the
  // parent) would re-run it and steal focus back to the first field on every
  // keystroke. Routing through a ref keeps the effect mount-only while still
  // always calling the latest onClose.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const card = cardRef.current;

    // Prefer the first real control; fall back to the card itself (tabIndex
    // -1 below) so focus never stays stranded outside the dialog.
    const firstFocusable = card?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? card)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !card) return;

      const focusables = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    // The overlay is a click-to-dismiss convenience for mouse users only;
    // Escape is the keyboard equivalent, so it is intentionally aria-hidden
    // from the accessibility tree rather than exposed as a fake button.
    <div className="modal-overlay" style={{ display: "flex" }} onClick={onClose}>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="modal-card"
        style={{ maxWidth: width, maxHeight: "82vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
