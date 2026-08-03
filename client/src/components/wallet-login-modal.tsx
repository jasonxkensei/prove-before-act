import { useState, useEffect, useRef, useCallback } from "react";
import { logger } from "@/lib/logger";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProviderFactory } from '@multiversx/sdk-dapp/out/providers/ProviderFactory';
import { ProviderTypeEnum } from '@multiversx/sdk-dapp/out/providers/types/providerFactory.types';
import { loginAction, logoutAction } from '@multiversx/sdk-dapp/out/store/actions/sharedActions/sharedActions';
import { nativeAuth } from '@multiversx/sdk-dapp/out/services/nativeAuth/nativeAuth';
import { useGetIsLoggedIn } from '@multiversx/sdk-dapp/out/react/account/useGetIsLoggedIn';
import { useGetAccount } from '@multiversx/sdk-dapp/out/react/account/useGetAccount';
import { Shield, Wallet, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/queryClient";

interface WalletLoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectTo?: string;
}

export function WalletLoginModal({ open, onOpenChange, redirectTo }: WalletLoginModalProps) {
  const [loading, setLoading] = useState<string | null>(null); // which button is loading
  const [error, setError] = useState<string | null>(null);
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  const providerRef = useRef<any>(null);
  const syncAttempted = useRef(false);
  const pendingTokenRef = useRef<string | null>(null);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const isLoggedIn = useGetIsLoggedIn();
  const { address } = useGetAccount();

  // AUTH-M1: Specific key for our Native Auth token — avoids picking up tokens
  // from third-party libraries via broad regex scanning (token injection risk).
  const XPROOF_NATIVE_AUTH_KEY = 'xproof_native_auth_token';

  const getNativeAuthToken = (): string | null => {
    // 1. In-memory token from current login flow (most reliable — no storage required)
    if (pendingTokenRef.current) return pendingTokenRef.current;
    // 2. Our own specific localStorage key written during a previous login
    const ours = localStorage.getItem(XPROOF_NATIVE_AUTH_KEY);
    if (ours && ours.length > 50) return ours;
    // 3. Legacy key names written by older app versions
    const legacy = localStorage.getItem('nativeAuthToken') || localStorage.getItem('loginToken');
    if (legacy && legacy.length > 50) return legacy;
    return null;
  };

  const syncAndRedirect = useCallback(async (walletAddress: string): Promise<boolean> => {
    if (syncAttempted.current) return false;
    syncAttempted.current = true;

    try {
      logger.log('Syncing wallet with backend:', walletAddress);

      const nativeAuthToken = getNativeAuthToken();
      if (!nativeAuthToken) {
        logger.error('No native auth token available; cannot authenticate without cryptographic proof');
        setError('Authentication requires a cryptographic signature from your wallet. Please try connecting again.');
        setLoading(null);
        setWaitingForConnection(false);
        syncAttempted.current = false;
        return false;
      }

      const response = await fetch('/api/auth/wallet/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nativeAuthToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({ walletAddress }),
      });

      if (response.ok) {
        const userData = await response.json();
        logger.log('Backend sync successful');

        localStorage.setItem('walletAddress', walletAddress);
        // Session cookie is now the durable credential — the native auth token
        // only needs to survive until sync succeeds. Clearing it now narrows
        // its localStorage exposure window without affecting any functionality.
        // Logout cleanup (wallet-login-modal.tsx handleLogout) keeps the
        // belt-and-suspenders removeItem as a fallback for any edge case where
        // this line was somehow skipped (e.g. an older tab still holding the key).
        localStorage.removeItem(XPROOF_NATIVE_AUTH_KEY);
        pendingTokenRef.current = null;

        loginAction({ address: walletAddress, providerType: ProviderTypeEnum.extension });

        queryClient.setQueryData(['/api/auth/me'], userData);
        await queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });

        toast({
          title: "Wallet connected",
          description: `Connected: ${walletAddress.substring(0, 10)}...${walletAddress.slice(-6)}`,
        });

        onOpenChange(false);
        navigate(redirectTo || '/dashboard');

        return true;
      } else {
        const errorBody = await response.text().catch(() => 'Unknown error');
        logger.error('Backend sync failed:', response.status, errorBody);

        setError('Sync failed. Please try again.');
        setLoading(null);
        setWaitingForConnection(false);
        syncAttempted.current = false;

        toast({
          title: "Connection error",
          description: "Unable to create your session.",
          variant: "destructive"
        });

        return false;
      }
    } catch (err) {
      logger.error('Sync error:', err);
      setError('Server connection error.');
      setLoading(null);
      setWaitingForConnection(false);
      syncAttempted.current = false;

      toast({
        title: "Connection error",
        description: "An error occurred.",
        variant: "destructive"
      });

      return false;
    }
  }, [toast, onOpenChange, navigate, redirectTo]);

  useEffect(() => {
    if (isLoggedIn && address && open && !syncAttempted.current) {
      logger.log('SDK detected login:', address);
      syncAndRedirect(address);
    }
  }, [isLoggedIn, address, open, syncAndRedirect]);

  useEffect(() => {
    if (!open) {
      setLoading(null);
      setError(null);
      setWaitingForConnection(false);
      syncAttempted.current = false;
      pendingTokenRef.current = null;
    }
  }, [open]);

  const handleProviderLogin = async (providerType: (typeof ProviderTypeEnum)[keyof typeof ProviderTypeEnum], buttonKey: string) => {
    setLoading(buttonKey);
    setError(null);
    syncAttempted.current = false;
    pendingTokenRef.current = null;

    try {
      try { logoutAction(); } catch (_e) { /* cleanup non-fatal */ }

      const provider = await ProviderFactory.create({ type: providerType });
      providerRef.current = provider;

      if (typeof provider.init === 'function') {
        await provider.init();
      }

      // Generate the nativeAuth init token. The wallet will sign this and
      // return a signature, which we then compose into the final auth token.
      // Without this, the wallet has nothing to sign and no token comes back.
      const nativeAuthClient = nativeAuth({ expirySeconds: 86400 });
      const initToken = await nativeAuthClient.initialize();
      logger.log('Generated nativeAuth init token');

      const loginResult = await provider.login({ token: initToken });

      let walletAddress = '';
      let signature = '';

      if (loginResult && typeof loginResult === 'object') {
        if ('address' in loginResult) walletAddress = (loginResult as any).address;
        if ('signature' in loginResult) signature = (loginResult as any).signature || '';
        // Some providers return the full nativeAuth token directly
        if ('accessToken' in loginResult && (loginResult as any).accessToken) {
          pendingTokenRef.current = (loginResult as any).accessToken;
          // AUTH-M1: Also persist under our specific key so that a page refresh
          // mid-login (before /api/auth/wallet/sync completes) does not strand
          // the user — useWalletAuth.getNativeAuthTokenFromStorage() reads from
          // this key on reload and can retry the sync automatically.
          localStorage.setItem(XPROOF_NATIVE_AUTH_KEY, (loginResult as any).accessToken);
          logger.log('Got accessToken directly from login result');
        }
      }

      // If we have address + signature but no accessToken, compose it ourselves
      if (!pendingTokenRef.current && walletAddress && signature) {
        try {
          const finalToken = nativeAuthClient.getToken({
            address: walletAddress,
            token: initToken,
            signature,
          });
          pendingTokenRef.current = finalToken;
          // AUTH-M1: Persist under specific key so useWalletAuth can find it
          // on subsequent page loads without a broad localStorage scan.
          localStorage.setItem(XPROOF_NATIVE_AUTH_KEY, finalToken);
          logger.log('Composed nativeAuth token from address + init + signature');
        } catch (e) {
          logger.error('Failed to compose nativeAuth token', e);
        }
      }

      if (!walletAddress) {
        try {
          if (typeof (provider as any).getAddress === 'function') {
            walletAddress = await (provider as any).getAddress();
          }
        } catch (_e) { /* fallback */ }
      }

      if (!walletAddress && (provider as any).account?.address) {
        walletAddress = (provider as any).account.address;
      }

      if (walletAddress && walletAddress.startsWith('erd1')) {
        await syncAndRedirect(walletAddress);
      } else {
        // For providers that resolve asynchronously (e.g. web wallet popup)
        setWaitingForConnection(true);
        let attempts = 0;
        const maxAttempts = 60;
        const checkAddress = setInterval(async () => {
          attempts++;
          let addr = '';
          try {
            if (typeof (provider as any).getAddress === 'function') {
              addr = await (provider as any).getAddress();
            }
          } catch (_e) { /* retry */ }

          if (!addr && (provider as any).account?.address) {
            addr = (provider as any).account.address;
          }

          if (addr && addr.startsWith('erd1')) {
            clearInterval(checkAddress);
            setWaitingForConnection(false);
            await syncAndRedirect(addr);
          } else if (attempts >= maxAttempts) {
            clearInterval(checkAddress);
            setWaitingForConnection(false);
            setLoading(null);
            setError('Connection timed out. Please refresh the page and try again.');
          }
        }, 500);
      }
    } catch (err: any) {
      logger.error(`${providerType} login error:`, err);
      const errorMsg = err.message || "Connection failed. Please try again.";
      setError(`Error: ${errorMsg}`);
      toast({
        title: "Connection failed",
        description: errorMsg,
        variant: "destructive"
      });
      setLoading(null);
      setWaitingForConnection(false);
    }
  };

  if (waitingForConnection) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="modal-wallet-login">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              Connecting...
            </DialogTitle>
            <DialogDescription>
              Complete the connection in the wallet window
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center py-4 space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-center text-muted-foreground">
              Waiting for approval...
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="modal-wallet-login">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Connect your wallet
          </DialogTitle>
          <DialogDescription>
            Choose how to sign in with your MultiversX wallet
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          <Button
            onClick={() => handleProviderLogin(ProviderTypeEnum.extension, 'extension')}
            disabled={loading !== null}
            className="w-full justify-start gap-3"
            variant="default"
            data-testid="button-extension-login"
          >
            {loading === 'extension' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Wallet className="h-5 w-5" />
            )}
            <div className="flex flex-col items-start text-left">
              <span>Browser Extension</span>
              <span className="text-xs font-normal opacity-70">MultiversX DeFi Wallet extension</span>
            </div>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Secure authentication via cryptographic signature
        </p>
      </DialogContent>
    </Dialog>
  );
}
