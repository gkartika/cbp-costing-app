import type { ReactNode } from "react";

export function Ticket({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  return (
    <div className="ticket">
      <div className="ticket-head">
        <h2>{title}</h2>
        {tag && <div className="ticket-tag">{tag}</div>}
      </div>
      <div className="perf" />
      <div className="ticket-body">{children}</div>
    </div>
  );
}

export function TicketLine({
  label,
  value,
  sub,
  err,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: boolean;
  err?: boolean;
}) {
  return (
    <div className={`ticket-line${sub ? " sub" : ""}${err ? " err" : ""}`}>
      <span>{label}</span>
      <span className="val">{value}</span>
    </div>
  );
}

export function TicketDivider() {
  return <div className="ticket-divider" />;
}

export function TicketTotal({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="ticket-footer">
      <div className="ticket-total">
        <span className="label">{label}</span>
        <span className="val">{value}</span>
      </div>
      {note && <div className="ticket-note">{note}</div>}
    </div>
  );
}
