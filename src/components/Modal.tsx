import type { ReactNode } from "react";

export function Modal({
  onClose,
  width = 500,
  children,
}: {
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" style={{ display: "flex" }} onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: width, maxHeight: "82vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
