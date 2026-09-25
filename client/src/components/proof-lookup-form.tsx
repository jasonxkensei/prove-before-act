import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackEvent } from "@/lib/analytics";
import { parsePublicProofId } from "@/lib/proof-lookup";

export function ProofLookupForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [, navigate] = useLocation();

  const openProof = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = parsePublicProofId(value, window.location.origin);
    if (!id) {
      setError("Enter a public proof ID or a Prove Before Act proof link.");
      return;
    }
    setError("");
    trackEvent("proof_lookup_submitted", { location: "landing" });
    navigate(`/proof/${encodeURIComponent(id)}`);
  };

  return (
    <form onSubmit={openProof} className="mt-6" data-testid="form-proof-lookup">
      <label htmlFor="proof-lookup" className="text-xs font-medium text-foreground">
        Proof link or ID
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <Input
          id="proof-lookup"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
          placeholder="Paste a proof link or ID"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "proof-lookup-error" : undefined}
          className="min-w-0 flex-1 font-mono text-sm"
          data-testid="input-proof-lookup"
        />
        <Button type="submit" disabled={!value.trim()} className="shrink-0" data-testid="button-open-proof">
          Open proof <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
      {error && (
        <p id="proof-lookup-error" role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}