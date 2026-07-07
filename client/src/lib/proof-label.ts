export interface EligibleProofLabelInput {
  id: string;
  file_name: string | null;
  confidence_level: string | number;
  created_at: string | null;
}

export function buildProofOptionLabel(p: EligibleProofLabelInput): string {
  const dateStr = p.created_at
    ? new Date(p.created_at).toISOString().slice(0, 10)
    : "";
  const label = p.file_name
    ? `${p.file_name} — confidence: ${p.confidence_level}`
    : `${p.id.slice(0, 12)}… — confidence: ${p.confidence_level}`;
  return dateStr ? `${label} · ${dateStr}` : label;
}
