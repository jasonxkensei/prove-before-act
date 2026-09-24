import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle2, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import { WalletLoginModal } from "@/components/wallet-login-modal";

type CreditPackage = {
  id: string;
  name: string;
  description: string;
  certs: number;
  price_usdc: string;
  price_per_cert: string;
};

type PackagesResponse = {
  packages: CreditPackage[];
  payment_methods?: Array<{ provider: string; label: string; checkout_endpoint?: string }>;
};

export default function CreditsPage() {
  const { toast } = useToast();
  const { isAuthenticated } = useWalletAuth();
  const [loadingPackage, setLoadingPackage] = useState<string | null>(null);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<"waiting" | "paid" | null>(null);
  const sessionId = new URLSearchParams(window.location.search).get("session_id");
  const returnState = new URLSearchParams(window.location.search).get("stripe");

  const { data, isLoading } = useQuery<PackagesResponse>({
    queryKey: ["/api/credits/packages"],
  });

  useEffect(() => {
    if (returnState === "cancelled") {
      toast({ title: "Checkout cancelled", description: "No payment was taken and no credits were added." });
    }
    if (returnState !== "success" || !sessionId) return;
    setPaymentStatus("waiting");
    let stopped = false;
    let timer: number | undefined;
    const check = async () => {
      const response = await fetch(`/api/credits/stripe/status/${encodeURIComponent(sessionId)}`, {
        credentials: "include",
      });
      if (!response.ok || stopped) return;
      const result = await response.json();
      if (result.status === "paid") {
        setPaymentStatus("paid");
        toast({
          title: "Payment confirmed",
          description: `${result.credits.toLocaleString()} certification credits were added to your account.`,
        });
        return;
      }
      timer = window.setTimeout(check, 1500);
    };
    void check();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [returnState, sessionId, toast]);

  const startStripeCheckout = async (packageId: string) => {
    if (!isAuthenticated) {
      setIsLoginModalOpen(true);
      return;
    }
    setLoadingPackage(packageId);
    try {
      const response = await fetch("/api/credits/stripe/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package_id: packageId }),
      });
      const result = await response.json();
      if (!response.ok || !result.checkout_url) {
        throw new Error(result.message || "Stripe checkout is temporarily unavailable");
      }
      window.location.assign(result.checkout_url);
    } catch (error) {
      toast({
        title: "Checkout unavailable",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      setLoadingPackage(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="operational-header">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/pba-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard"><ArrowLeft className="mr-2 h-4 w-4" />Dashboard</Link>
          </Button>
        </div>
      </header>

      <main id="main-content" className="container mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="mb-8 max-w-3xl">
          <Badge variant="outline" className="mb-4">Prepaid certification credits</Badge>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Choose a certification pack</h1>
          <p className="mt-3 text-muted-foreground">
            Pay securely with Stripe. USDC on Base remains available through the API as an alternative payment method.
          </p>
        </div>

        {paymentStatus && (
          <Card className="mb-8 border-primary/40 bg-primary/5">
            <CardContent className="flex items-center gap-3 p-5">
              {paymentStatus === "paid"
                ? <CheckCircle2 className="h-6 w-6 text-primary" />
                : <Loader2 className="h-6 w-6 animate-spin text-primary" />}
              <div>
                <p className="font-medium">{paymentStatus === "paid" ? "Credits added" : "Confirming your payment"}</p>
                <p className="text-sm text-muted-foreground">
                  {paymentStatus === "paid"
                    ? "Your new balance is ready for paid certifications."
                    : "Stripe has returned you safely. We are waiting for the signed payment confirmation."}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>
        ) : (
          <div className="grid gap-5 md:grid-cols-3">
            {data?.packages.map((pkg) => (
              <Card key={pkg.id} className="flex flex-col border-border/70 bg-muted/10 shadow-none">
                <CardHeader>
                  <CardTitle>{pkg.name}</CardTitle>
                  <p className="text-sm text-muted-foreground">{pkg.description}</p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <div className="mb-6">
                    <p className="text-3xl font-semibold tabular-nums">${pkg.price_usdc}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{pkg.certs.toLocaleString()} certifications</p>
                  </div>
                  <Button
                    className="mt-auto w-full"
                    size="lg"
                    disabled={loadingPackage !== null}
                    onClick={() => startStripeCheckout(pkg.id)}
                    data-testid={`button-stripe-checkout-${pkg.id}`}
                  >
                    {loadingPackage === pkg.id
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <CreditCard className="mr-2 h-4 w-4" />}
                    Pay with Stripe
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="mt-8 flex items-start gap-3 border-l-2 border-primary/40 bg-muted/20 p-4 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p>
            Checkout is hosted by Stripe. Credits are added only after Prove Before Act verifies Stripe’s signed webhook;
            the browser return page cannot grant credits.
          </p>
        </div>
      </main>
      <WalletLoginModal
        open={isLoginModalOpen}
        onOpenChange={setIsLoginModalOpen}
        redirectTo="/billing"
      />
    </div>
  );
}
