import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Network, Plus, Trash2, UserPlus, Loader2, ShieldCheck,
  ChevronDown, ChevronUp, Copy, X, ArrowRight, Pencil, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { formatDistanceToNow } from "date-fns";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FleetMember {
  wallet_address: string;
  proof_method: "owner_wallet" | "signature" | "api_key";
  added_at: string | null;
}

interface Fleet {
  id: string;
  name: string;
  slug: string;
  created_at: string | null;
  members: FleetMember[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateWallet(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function ownershipMessage(slug: string, wallet: string) {
  return `xproof-fleet-member:${slug}:${wallet}`;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

// ── Add-member sub-form ───────────────────────────────────────────────────────

interface AddMemberFormProps {
  fleet: Fleet;
  sessionWallet: string;
  onClose: () => void;
}

function AddMemberForm({ fleet, sessionWallet, onClose }: AddMemberFormProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [wallet, setWallet] = useState("");
  const [proofType, setProofType] = useState<"signature" | "api_key">("signature");
  const [signature, setSignature] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [copied, setCopied] = useState(false);

  const trimmedWallet = wallet.trim();
  const isOwnWallet = trimmedWallet.toLowerCase() === sessionWallet.toLowerCase();
  const msgToSign = trimmedWallet ? ownershipMessage(fleet.slug, trimmedWallet) : "";

  const copyMsg = () => {
    if (!msgToSign) return;
    navigator.clipboard.writeText(msgToSign).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { wallet_address: trimmedWallet };
      if (!isOwnWallet) {
        if (proofType === "signature") body.signature = signature.trim();
        else body.api_key = apiKey.trim();
      }
      const res = await apiRequest("POST", `/api/fleets/${fleet.slug}/members`, body);
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/fleets"] });
      toast({
        title: data.already_member ? "Already a member" : "Member added",
        description: data.already_member
          ? `${truncateWallet(trimmedWallet)} was already in the fleet.`
          : `${truncateWallet(trimmedWallet)} added to ${fleet.name}.`,
      });
      onClose();
    },
    onError: (err: Error) => {
      let msg = err.message;
      try {
        const inner = JSON.parse(msg.replace(/^\d+: /, ""));
        msg = inner.message || msg;
      } catch { /* raw message */ }
      toast({ title: "Failed to add member", description: msg, variant: "destructive" });
    },
  });

  const canSubmit = trimmedWallet.length > 0 && (
    isOwnWallet ||
    (proofType === "signature" && signature.trim().length > 0) ||
    (proofType === "api_key" && apiKey.trim().length > 0)
  );

  return (
    <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Add a member wallet</p>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Wallet address */}
      <div className="space-y-1.5">
        <Label htmlFor={`wallet-${fleet.id}`} className="text-xs">Member wallet address</Label>
        <Input
          id={`wallet-${fleet.id}`}
          data-testid={`input-member-wallet-${fleet.slug}`}
          placeholder="erd1…"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          className="font-mono text-sm"
        />
      </div>

      {/* Ownership proof section */}
      {trimmedWallet && (
        isOwnWallet ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            This is your connected wallet — no additional proof needed.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Proof type toggle */}
            <div className="flex rounded-md border p-0.5 w-fit">
              <Button
                type="button" size="sm"
                variant={proofType === "signature" ? "secondary" : "ghost"}
                className="h-7 text-xs"
                onClick={() => setProofType("signature")}
                data-testid={`button-proof-sig-${fleet.slug}`}
              >
                Ed25519 signature
              </Button>
              <Button
                type="button" size="sm"
                variant={proofType === "api_key" ? "secondary" : "ghost"}
                className="h-7 text-xs"
                onClick={() => setProofType("api_key")}
                data-testid={`button-proof-key-${fleet.slug}`}
              >
                API key
              </Button>
            </div>

            {proofType === "signature" ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Sign the following message with the member wallet's Ed25519 private key.
                  Paste the hex-encoded raw signature below.
                </p>
                {/* Message to sign */}
                <div className="rounded-md bg-muted/60 border px-3 py-2 flex items-center justify-between gap-2">
                  <code className="font-mono text-xs break-all select-all" data-testid={`text-msg-to-sign-${fleet.slug}`}>
                    {msgToSign}
                  </code>
                  <Button
                    type="button" variant="ghost" size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={copyMsg}
                    title="Copy message to sign"
                    data-testid={`button-copy-msg-${fleet.slug}`}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {copied && <p className="text-xs text-emerald-600 dark:text-emerald-400">Copied!</p>}
                <Input
                  placeholder="0a1b2c3d… (hex-encoded Ed25519 signature)"
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  className="font-mono text-xs"
                  data-testid={`input-sig-${fleet.slug}`}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Provide an active API key (<code className="font-mono">pm_…</code>) belonging
                  to the account that owns this wallet address.
                </p>
                <Input
                  type="password"
                  placeholder="pm_…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="font-mono text-xs"
                  data-testid={`input-apikey-${fleet.slug}`}
                />
              </div>
            )}
          </div>
        )
      )}

      <Button
        size="sm"
        disabled={!canSubmit || addMutation.isPending}
        onClick={() => addMutation.mutate()}
        data-testid={`button-add-member-${fleet.slug}`}
      >
        {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
        Add member
      </Button>
    </div>
  );
}

// ── Fleet card ────────────────────────────────────────────────────────────────

interface FleetCardProps {
  fleet: Fleet;
  sessionWallet: string;
  onDeleteRequest: (slug: string) => void;
}

function FleetCard({ fleet, sessionWallet, onDeleteRequest }: FleetCardProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addingMember, setAddingMember] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(fleet.name);

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PATCH", `/api/fleets/${fleet.slug}`, { name });
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/fleets"] });
      toast({ title: "Fleet renamed", description: `Fleet is now called "${data.fleet.name}".` });
      setRenaming(false);
    },
    onError: (err: Error) => {
      let msg = err.message;
      try {
        const inner = JSON.parse(msg.replace(/^\d+: /, ""));
        msg = inner.message || msg;
      } catch { /* raw */ }
      toast({ title: "Failed to rename fleet", description: msg, variant: "destructive" });
    },
  });

  function startRename() {
    setDraftName(fleet.name);
    setRenaming(true);
  }

  function cancelRename() {
    setDraftName(fleet.name);
    setRenaming(false);
  }

  function submitRename() {
    const trimmed = draftName.trim();
    if (trimmed.length < 2) {
      toast({ title: "Name too short", description: "Fleet name must be at least 2 characters.", variant: "destructive" });
      return;
    }
    renameMutation.mutate(trimmed);
  }

  const removeMutation = useMutation({
    mutationFn: async (walletAddress: string) => {
      await apiRequest("DELETE", `/api/fleets/${fleet.slug}/members/${encodeURIComponent(walletAddress)}`);
    },
    onSuccess: (_, walletAddress) => {
      qc.invalidateQueries({ queryKey: ["/api/fleets"] });
      toast({ title: "Member removed", description: `${truncateWallet(walletAddress)} removed from ${fleet.name}.` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove member", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid={`card-fleet-${fleet.slug}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-2">
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") cancelRename();
                  }}
                  className="h-7 text-sm font-semibold"
                  autoFocus
                  data-testid={`input-rename-fleet-${fleet.slug}`}
                  disabled={renameMutation.isPending}
                />
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 shrink-0 text-primary hover:text-primary"
                  onClick={submitRename}
                  disabled={renameMutation.isPending}
                  data-testid={`button-save-rename-${fleet.slug}`}
                  title="Save name"
                >
                  {renameMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={cancelRename}
                  disabled={renameMutation.isPending}
                  data-testid={`button-cancel-rename-${fleet.slug}`}
                  title="Cancel"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group">
                <CardTitle className="text-base">{fleet.name}</CardTitle>
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={startRename}
                  data-testid={`button-rename-fleet-${fleet.slug}`}
                  title="Rename fleet"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CardDescription className="font-mono text-xs mt-0.5">
              slug: {fleet.slug}
              {fleet.created_at && (
                <span className="ml-2 text-muted-foreground/70">
                  · created {formatDistanceToNow(new Date(fleet.created_at), { addSuffix: true })}
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button asChild variant="ghost" size="sm" className="h-8 text-xs gap-1.5">
              <Link href={`/fleet?fleet=${fleet.slug}`}>
                View coherence
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button
              variant="ghost" size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onDeleteRequest(fleet.slug)}
              data-testid={`button-delete-fleet-${fleet.slug}`}
              title="Delete fleet"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Member list */}
        {fleet.members.length === 0 ? (
          <p className="text-xs text-muted-foreground">No members yet. Add the first one below.</p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs" data-testid={`table-members-${fleet.slug}`}>
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Wallet</th>
                  <th className="hidden px-3 py-2 text-left font-medium text-muted-foreground sm:table-cell">Proof method</th>
                  <th className="hidden px-3 py-2 text-left font-medium text-muted-foreground md:table-cell">Added</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {fleet.members.map((m) => (
                  <tr key={m.wallet_address} className="border-b last:border-0">
                    <td className="px-3 py-2 font-mono">{truncateWallet(m.wallet_address)}</td>
                    <td className="hidden px-3 py-2 sm:table-cell">
                      <Badge variant="outline" className="text-[10px]">
                        {m.proof_method.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                      {m.added_at
                        ? formatDistanceToNow(new Date(m.added_at), { addSuffix: true })
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost" size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => removeMutation.mutate(m.wallet_address)}
                        disabled={removeMutation.isPending}
                        data-testid={`button-remove-member-${fleet.slug}-${m.wallet_address.slice(-6)}`}
                        title="Remove member"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add member toggle */}
        {addingMember ? (
          <AddMemberForm
            fleet={fleet}
            sessionWallet={sessionWallet}
            onClose={() => setAddingMember(false)}
          />
        ) : (
          <Button
            variant="outline" size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setAddingMember(true)}
            data-testid={`button-open-add-member-${fleet.slug}`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add member
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Create fleet form ─────────────────────────────────────────────────────────

interface CreateFleetFormProps {
  onCreated: () => void;
}

function CreateFleetForm({ onCreated }: CreateFleetFormProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [open, setOpen] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { name: name.trim() };
      if (slug.trim()) body.slug = slug.trim().toLowerCase();
      const res = await apiRequest("POST", "/api/fleets", body);
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/fleets"] });
      toast({ title: "Fleet created", description: `"${data.fleet.name}" is ready. Add members below.` });
      setName("");
      setSlug("");
      setOpen(false);
      onCreated();
    },
    onError: (err: Error) => {
      let msg = err.message;
      try {
        const inner = JSON.parse(msg.replace(/^\d+: /, ""));
        msg = inner.message || msg;
      } catch { /* raw */ }
      toast({ title: "Failed to create fleet", description: msg, variant: "destructive" });
    },
  });

  const slugInvalid = slug.trim().length > 0 && !SLUG_REGEX.test(slug.trim().toLowerCase());

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        data-testid="button-new-fleet"
        className="gap-1.5"
      >
        <Plus className="h-4 w-4" />
        New fleet
      </Button>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Create a fleet</CardTitle>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="fleet-name" className="text-xs">Fleet name</Label>
          <Input
            id="fleet-name"
            data-testid="input-fleet-name"
            placeholder="Acme Agents"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fleet-slug" className="text-xs">
            Slug <span className="text-muted-foreground">(optional — auto-derived from name)</span>
          </Label>
          <Input
            id="fleet-slug"
            data-testid="input-fleet-slug"
            placeholder="acme-agents"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono text-sm"
          />
          {slugInvalid && (
            <p className="text-xs text-destructive">
              Slug must be 3–60 characters: lowercase letters, digits, hyphens; start and end with a letter or digit.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={name.trim().length < 2 || slugInvalid || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="button-create-fleet"
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Create fleet
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FleetManagePage() {
  const { isAuthenticated, isLoading: authLoading, walletAddress } = useWalletAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    document.title = "My Fleets | xproof";
  }, []);

  const { data, isLoading } = useQuery<{ fleets: Fleet[] }>({
    queryKey: ["/api/fleets"],
    enabled: isAuthenticated,
    queryFn: async () => {
      const res = await fetch("/api/fleets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load fleets");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (slug: string) => {
      await apiRequest("DELETE", `/api/fleets/${slug}`);
    },
    onSuccess: (_, slug) => {
      qc.invalidateQueries({ queryKey: ["/api/fleets"] });
      toast({ title: "Fleet deleted", description: `Fleet "${slug}" has been deleted.` });
      setDeleteSlug(null);
      setDeleteConfirmText("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete fleet", description: err.message, variant: "destructive" });
    },
  });

  if (!authLoading && !isAuthenticated) {
    return <Redirect to="/" />;
  }

  const fleets = data?.fleets ?? [];
  const deleteTarget = fleets.find((f) => f.slug === deleteSlug);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Link href="/" data-testid="link-logo-home" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
          </Link>
          <nav className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm">
              <Link href="/fleet">Fleet Coherence</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          </nav>
        </div>
      </header>

      <div className="container mx-auto max-w-3xl py-12 space-y-8">
        {/* Page heading */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Network className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">My Fleets</h1>
            </div>
            <p className="text-sm text-muted-foreground max-w-lg">
              Create named fleets of agent wallets and manage membership. The public Fleet
              Coherence view aggregates stats over the exact members you register here.
            </p>
          </div>
          <CreateFleetForm onCreated={() => {}} />
        </div>

        {/* Fleet list */}
        {authLoading || isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : fleets.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
              <Network className="h-12 w-12 text-muted-foreground/40" />
              <div>
                <p className="font-medium text-muted-foreground">No fleets yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first fleet to start registering member wallets.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-5">
            {fleets.map((fleet) => (
              <FleetCard
                key={fleet.id}
                fleet={fleet}
                sessionWallet={walletAddress ?? ""}
                onDeleteRequest={(slug) => {
                  setDeleteSlug(slug);
                  setDeleteConfirmText("");
                }}
              />
            ))}
          </div>
        )}

        {/* How ownership proof works */}
        <Card className="border-muted">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              How ownership proof works
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2 leading-relaxed">
            <p>
              When adding a member wallet you must prove you control it. Three methods are accepted:
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong className="text-foreground">Owner wallet</strong> — the wallet is your
                own connected session wallet. No extra step required.
              </li>
              <li>
                <strong className="text-foreground">Ed25519 signature</strong> — sign the
                message{" "}
                <code className="font-mono bg-muted px-1 rounded">
                  xproof-fleet-member:{"<slug>"}:{"<wallet>"}
                </code>{" "}
                with the member wallet's private key and paste the hex-encoded raw signature.
              </li>
              <li>
                <strong className="text-foreground">API key</strong> — provide an active{" "}
                <code className="font-mono bg-muted px-1 rounded">pm_…</code> key belonging to
                the account that owns the member wallet.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Delete fleet confirmation dialog */}
      <Dialog
        open={deleteSlug !== null}
        onOpenChange={(open) => {
          if (!open) { setDeleteSlug(null); setDeleteConfirmText(""); }
        }}
      >
        <DialogContent data-testid="dialog-delete-fleet">
          <DialogHeader>
            <DialogTitle>Delete fleet "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>
              This permanently removes the fleet and all its registered members. The action
              cannot be undone. Type the slug{" "}
              <strong className="font-mono">{deleteSlug}</strong> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={deleteSlug ?? ""}
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            className="font-mono text-sm"
            data-testid="input-delete-confirm"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setDeleteSlug(null); setDeleteConfirmText(""); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirmText !== deleteSlug || deleteMutation.isPending}
              onClick={() => deleteSlug && deleteMutation.mutate(deleteSlug)}
              data-testid="button-confirm-delete-fleet"
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Delete fleet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
