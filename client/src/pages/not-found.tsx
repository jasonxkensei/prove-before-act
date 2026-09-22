import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="page-shell flex min-h-[100dvh] flex-col">
      <header className="operational-header">
        <div className="container flex h-16 items-center px-4">
          <Link href="/" className="flex items-center" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6">
      <Card className="panel w-full max-w-md">
        <CardContent className="flex flex-col items-center py-16 text-center">
          <Shield className="mb-4 h-16 w-16 text-muted-foreground/50" />
          <h1 className="mb-2 text-4xl font-bold">404</h1>
          <p className="mb-6 text-muted-foreground">
            The page you're looking for doesn't exist
          </p>
           <Button asChild data-testid="button-go-home">
             <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Go Home
             </Link>
          </Button>
        </CardContent>
      </Card>
      </main>
    </div>
  );
}
