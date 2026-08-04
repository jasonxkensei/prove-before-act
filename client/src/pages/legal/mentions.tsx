import { Shield, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function MentionsLegales() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
      </header>

      <main className="container py-12 max-w-3xl">
        <h1 className="text-3xl font-bold mb-8" data-testid="text-page-title">Legal notices</h1>
        
        <div className="prose prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-xl font-semibold mb-4">Service operator</h2>
            <p className="text-muted-foreground leading-relaxed">
              The Prove Before Act service is currently operated by a sole proprietor based in France, 
              pending the establishment of a dedicated legal entity.
            </p>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li><strong className="text-foreground">Service name:</strong> Prove Before Act</li>
              <li><strong className="text-foreground">Country:</strong> France</li>
              <li><strong className="text-foreground">Contact:</strong> <span className="italic">[Email coming soon]</span></li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Hosting</h2>
            <p className="text-muted-foreground leading-relaxed">
              The service is hosted by Replit, Inc.
            </p>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li><strong className="text-foreground">Company name:</strong> Replit, Inc.</li>
              <li><strong className="text-foreground">Address:</strong> 1555 Blake Street, Suite 301, Denver, CO 80202, USA</li>
              <li><strong className="text-foreground">Website:</strong> <a href="https://replit.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">replit.com</a></li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Blockchain infrastructure</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act uses the MultiversX blockchain for recording proof of existence.
              Transactions are public and verifiable on the MultiversX explorer.
            </p>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li><strong className="text-foreground">Blockchain:</strong> MultiversX (formerly Elrond)</li>
              <li><strong className="text-foreground">Explorer:</strong> <a href="https://explorer.multiversx.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">explorer.multiversx.com</a></li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Intellectual property</h2>
            <p className="text-muted-foreground leading-relaxed">
              All content on Prove Before Act (text, graphics, logos, icons, images, 
              software) is the exclusive property of Prove Before Act or its partners and is protected 
              by applicable intellectual property laws.
            </p>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Any reproduction, representation, modification, publication, or adaptation of all or 
              part of the elements of the site, by any means or process, is prohibited 
              without prior written authorization.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Limitation of liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act shall not be held liable for any direct or indirect damages resulting 
              from the use of the service, including but not limited to data loss or service 
              interruption.
            </p>
            <p className="text-muted-foreground leading-relaxed mt-4">
              The certification service relies on the MultiversX blockchain. The availability 
              and permanence of recorded proofs depend on the blockchain infrastructure.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Applicable law</h2>
            <p className="text-muted-foreground leading-relaxed">
              These legal notices are governed by applicable law. The service is operated from France. 
              In case of dispute, the parties shall first seek an amicable resolution before 
              resorting to the competent courts.
            </p>
          </section>

          <section className="border-t pt-8">
            <p className="text-sm text-muted-foreground">
              Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
