import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RecoveryJob = {
  id: string;
  jobId: string;
  status: string;
  step: number;
  step_name: string | null;
  known_hash: string | null;
  signer_nonce: string | null;
  intent_at: string | null;
  lastError: string | null;
  recovery_audit: Array<{ at: string; operator: string; decision: string; hash: string }>;
};

export function TxRecoveryCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useQuery<{
    chain_nonce: number;
    page: number;
    has_more: boolean;
    history: Array<{ hash: string | null; nonce: string | null; status: string | null }>;
    jobs: RecoveryJob[];
  }>({
    queryKey: [`/api/admin/tx-queue/recovery?page=${page}`], retry: false,
  });
  const mutation = useMutation({
    mutationFn: async ({ id, hash, decision }: { id: string; hash: string; decision: string }) =>
      apiRequest("POST", `/api/admin/tx-queue/recovery/${encodeURIComponent(id)}`, { hash, decision }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0]).startsWith("/api/admin/tx-queue/recovery?") });
    },
    onError: async (err: Error) => {
      // apiRequest includes the response body in its error message.
      setError(err.message);
    },
  });
  return (
    <Card>
      <CardHeader><CardTitle>Validation transaction recovery</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Only a finalized transaction matching the signer, nonce and exact job step can be reconciled.
          Missing or pending transactions cannot be acknowledged as rejected. Never retry an uncertain send without evidence.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Refresh chain nonce and jobs</Button>
        {isLoading && <p>Loading recovery jobs…</p>}
        {isError && <p role="alert">Could not load signer nonce or recovery jobs.</p>}
        {data && <p className="text-sm">Signer chain nonce: {data.chain_nonce} · Page {page + 1}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {data?.jobs.map(job => (
          <div key={job.id} className="border p-4 space-y-2 text-sm">
            <p className="font-medium break-all">Job {job.jobId} · {job.status} · Step {job.step + 1}: {job.step_name ?? "unknown"}</p>
            <p>Claimed nonce: {job.signer_nonce ?? "unknown"} · Intent: {job.intent_at ?? "unknown"}</p>
            <p className="break-all">Known hash: {job.known_hash ?? "none"}</p>
            <p className="text-muted-foreground">Recent chain history for this nonce (absence is not proof of rejection):</p>
            {data.history.filter(tx => tx.nonce === job.signer_nonce).map((tx, index) => (
              <p key={index} className="break-all font-mono">{tx.status ?? "unknown"} · {tx.hash ?? "no hash"}</p>
            ))}
            {job.lastError && <p className="text-muted-foreground">{job.lastError}</p>}
            <label className="block" htmlFor={`recovery-hash-${job.id}`}>Transaction hash (64 hex characters)</label>
            <input id={`recovery-hash-${job.id}`} className="w-full border bg-background p-2 font-mono"
              value={hashes[job.id] ?? job.known_hash ?? ""}
              onChange={event => setHashes({ ...hashes, [job.id]: event.target.value.trim() })}
              maxLength={64} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={mutation.isPending || !job.signer_nonce}
                onClick={() => mutation.mutate({ id: job.id, hash: hashes[job.id] ?? job.known_hash ?? "", decision: "confirmed" })}>
                Verify success and advance
              </Button>
              <Button size="sm" variant="outline" disabled={mutation.isPending || !job.signer_nonce}
                onClick={() => {
                  if (window.confirm("Only a finalized failed transaction permits a retry. Verify this hash on chain?")) {
                    mutation.mutate({ id: job.id, hash: hashes[job.id] ?? job.known_hash ?? "", decision: "rejected" });
                  }
                }}>Verify rejection and retry step</Button>
            </div>
            {job.recovery_audit.map((entry, index) => (
              <p key={index} className="text-xs text-muted-foreground break-all">
                {entry.at} · {entry.operator} · {entry.decision} · {entry.hash}
              </p>
            ))}
          </div>
        ))}
        {data && <div className="flex gap-2">
          <Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button variant="outline" disabled={!data.has_more} onClick={() => setPage(page + 1)}>Next</Button>
        </div>}
      </CardContent>
    </Card>
  );
}