import { Shield, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function PolitiqueConfidentialite() {
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
        <h1 className="text-3xl font-bold mb-8" data-testid="text-page-title">Privacy policy</h1>
        
        <div className="prose prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-xl font-semibold mb-4">Introduction</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act is committed to protecting the privacy of its users. This privacy 
              policy explains how we collect, use, and protect your personal data in 
              compliance with applicable data protection regulations, including the 
              General Data Protection Regulation (GDPR).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Data collected</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Prove Before Act only collects data strictly necessary for the operation of the service:
            </p>
            <ul className="space-y-3 text-muted-foreground">
              <li>
                <strong className="text-foreground">MultiversX wallet address:</strong> used for 
                authentication and associating certifications with your account.
              </li>
              <li>
                <strong className="text-foreground">SHA-256 file hash:</strong> cryptographic fingerprint 
                of your files. The original file is never transmitted or stored on our servers.
              </li>
              <li>
                <strong className="text-foreground">Certification metadata:</strong> file name, 
                certification date, author name (if provided).
              </li>
              <li>
                <strong className="text-foreground">Payment data:</strong> Payment transactions are processed via blockchain (MultiversX for EGLD, Base for USDC). We never store your banking information.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Data not collected</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              To ensure the confidentiality of your creations, Prove Before Act never collects:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li>The content of your files</li>
              <li>Your personal data (name, email, address) unless you voluntarily provide it</li>
              <li>Your browsing history outside of the service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Use of data</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Your data is used exclusively to:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li>Create and manage your blockchain certifications</li>
              <li>Generate PDF certificates and public proof pages</li>
              <li>Process payments</li>
              <li>Improve the service (aggregated and anonymized statistics)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Blockchain data (public)</h2>
            <p className="text-muted-foreground leading-relaxed">
              Certification proofs are recorded on the MultiversX blockchain, 
              a public and immutable ledger. The following information is publicly 
              accessible and cannot be deleted:
            </p>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li>SHA-256 hash of the certified file</li>
              <li>Wallet address that performed the certification</li>
              <li>Date and time of the transaction</li>
              <li>Certification identifier</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              <strong className="text-foreground">Important:</strong> The cryptographic hash does not allow 
              the original file to be reconstructed. Only the file owner can prove 
              that it matches the recorded hash.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Data retention</h2>
            <ul className="space-y-3 text-muted-foreground">
              <li>
                <strong className="text-foreground">Account data:</strong> retained as long as your 
                account is active, then deleted upon request.
              </li>
              <li>
                <strong className="text-foreground">Blockchain data:</strong> permanent and immutable 
                by design of blockchain technology.
              </li>
              <li>
                <strong className="text-foreground">Payment data:</strong> retained in accordance with 
                legal obligations (10 years for accounting data).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Your rights (GDPR)</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              In accordance with the GDPR, you have the following rights:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li><strong className="text-foreground">Right of access:</strong> obtain a copy of your data</li>
              <li><strong className="text-foreground">Right of rectification:</strong> correct your inaccurate data</li>
              <li><strong className="text-foreground">Right to erasure:</strong> delete your data (except blockchain data)</li>
              <li><strong className="text-foreground">Right to portability:</strong> receive your data in a structured format</li>
              <li><strong className="text-foreground">Right to object:</strong> object to the processing of your data</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              <strong className="text-foreground">Limitation:</strong> Data recorded on the blockchain 
              cannot be modified or deleted due to the immutable nature of this technology.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Sub-processors</h2>
            <ul className="space-y-3 text-muted-foreground">
              <li>
                <strong className="text-foreground">Replit, Inc.</strong> (hosting) - United States
              </li>
              <li>
                <strong className="text-foreground">Neon</strong> (database) - United States
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              To exercise your rights or for any questions regarding this privacy 
              policy, you can contact us at: <span className="italic">[Email coming soon]</span>
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
