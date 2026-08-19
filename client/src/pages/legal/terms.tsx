import { Shield, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export default function ConditionsUtilisation() {
  const { data: pricing } = useQuery<{ current_price_usd: number }>({
    queryKey: ["/api/pricing"],
  });
  const price = pricing ? `$${pricing.current_price_usd}` : "the current live rate";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
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
        <h1 className="text-3xl font-bold mb-8" data-testid="text-page-title">Terms of Use</h1>
        
        <div className="prose prose-invert max-w-none space-y-8">
          <section>
            <h2 className="text-xl font-semibold mb-4">1. Purpose of the service</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act is a digital certification service that allows you to record 
              proof of existence of files on the MultiversX blockchain. The service 
              generates a cryptographic fingerprint (SHA-256 hash) of your files and records it 
              permanently on the blockchain, thereby creating a timestamped and immutable proof.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">2. Acceptance of terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By using the Prove Before Act service, you fully and unconditionally accept these 
              Terms of Use. If you do not accept these terms, 
              you must not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">3. Registration and authentication</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Access to the service requires a connection via a compatible MultiversX wallet 
              (MultiversX DeFi Wallet Extension). The user is responsible for the security of 
              their wallet and private keys.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act never has access to your private keys and cannot recover access to 
              your account in case of loss of your wallet credentials.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">4. Description of the service</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The Prove Before Act service includes:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li>Generation of cryptographic fingerprints (SHA-256 hash) of files</li>
              <li>Recording of these fingerprints on the MultiversX blockchain</li>
              <li>Generation of downloadable PDF certificates</li>
              <li>Creation of verifiable public proof pages</li>
              <li>Access to a dashboard to manage your certifications</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">5. Pricing</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
               <strong className="text-foreground">Current live rate: {price} per certification.</strong> This is not a fixed published price; see <a className="text-primary underline" href="/api/pricing">/api/pricing</a> for the live quoted amount.
              payable in EGLD (the native cryptocurrency of MultiversX) at the exchange rate in effect 
              at the time of the transaction. Pricing is subject to change and may decrease as the network grows.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Blockchain network fees (gas fees) are included in this price when 
              payment is made through the integrated payment system. For transactions 
              signed directly by the user, network fees are the user's responsibility.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">6. User obligations</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The user agrees to:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li>Only certify files for which they hold the rights or authorization to certify</li>
              <li>Not use the service for illegal or fraudulent purposes</li>
              <li>Not attempt to compromise the security or operation of the service</li>
              <li>Provide accurate information during certification</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">7. Intellectual property</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act does not claim any rights over the files you certify. Certification 
              does not transfer any intellectual property rights. It solely constitutes 
              proof that the file existed in this form at a given date.
            </p>
            <p className="text-muted-foreground leading-relaxed mt-4">
              <strong className="text-foreground">Important:</strong> Prove Before Act certification does not constitute 
              proof of ownership or authorship. It only proves the existence 
              of the file at a specific date.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">8. Limitation of liability</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Prove Before Act strives to maintain a reliable and available service, but cannot guarantee:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li>Continuous and uninterrupted availability of the service</li>
              <li>Absence of errors or malfunctions</li>
              <li>Permanence of the MultiversX blockchain (third-party infrastructure)</li>
            </ul>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Under no circumstances shall Prove Before Act be held liable for direct or indirect damages, 
              data loss, revenue loss, or any other harm resulting from the use 
              or inability to use the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">9. Nature of certifications</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act certifications are based on blockchain technology and constitute 
              technical proofs of existence at a given date. Their legal value depends 
              on the applicable legislation and the assessment of the competent courts.
            </p>
            <p className="text-muted-foreground leading-relaxed mt-4">
              Prove Before Act recommends consulting a legal professional for any use 
              of certifications in a legal context.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">10. Immutability of blockchain data</h2>
            <p className="text-muted-foreground leading-relaxed">
              By design, data recorded on the blockchain is permanent and 
              immutable. Once a certification is performed, it is technically impossible 
              to modify or delete it. The user is informed of this and expressly accepts 
              it by using the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">11. Modification of terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Prove Before Act reserves the right to modify these Terms of Use 
              at any time. Users will be notified of significant changes. 
              Continued use of the service after notification 
              constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">12. Applicable law and jurisdiction</h2>
            <p className="text-muted-foreground leading-relaxed">
              These terms are governed by applicable law. The service is operated from France. 
              In case of dispute, and after failure of any attempt at amicable resolution, 
              the competent courts shall have jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-4">13. Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For any questions regarding these Terms of Use, you can 
              contact us at: <span className="italic">[Email coming soon]</span>
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
