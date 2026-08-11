export type TransactionFileState = "not_applied" | "applied" | "conflict";

/** Classifies a target without trusting a mutable progress counter in the journal. */
export function classifyTransactionFile(
  beforeHash: string | null,
  afterHash: string | null,
  currentHash: string | null
): TransactionFileState {
  if (currentHash === beforeHash) return "not_applied";
  if (currentHash === afterHash) return "applied";
  return "conflict";
}
