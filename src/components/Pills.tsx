const STATUS_TONE: Record<string, "neutral" | "amber" | "success" | "danger"> = {
  // costing_headers.status
  draft: "neutral",
  calculated: "amber",
  finalized: "success",
  revised: "success",
  voided: "danger",
  // guide_versions.status
  validated: "amber",
  published: "success",
  retired: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  calculated: "Calculated",
  finalized: "Finalized",
  revised: "Revised",
  voided: "Voided",
  validated: "Validated",
  published: "Published",
  retired: "Retired",
};

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return <span className={`pill ${tone}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function AccessPill({ canEdit }: { canEdit: boolean }) {
  return <span className={`pill ${canEdit ? "success" : "neutral"}`}>{canEdit ? "Edit" : "View-only"}</span>;
}
