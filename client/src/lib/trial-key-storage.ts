const TRIAL_KEY_STORAGE = "xproof_trial_api_key";
const TRIAL_AGENT_STORAGE = "xproof_trial_agent_name";
const TRIAL_HANDLED_STORAGE = "xproof_trial_key_handled";

export type StoredTrialKey = {
  apiKey: string;
  agentName: string;
  handled: boolean;
};

export function readStoredTrialKey(): StoredTrialKey | null {
  if (typeof window === "undefined") return null;
  try {
    const apiKey = window.sessionStorage.getItem(TRIAL_KEY_STORAGE);
    if (!apiKey || !apiKey.startsWith("pm_")) return null;
    return {
      apiKey,
      agentName: window.sessionStorage.getItem(TRIAL_AGENT_STORAGE) || "",
      handled: window.sessionStorage.getItem(TRIAL_HANDLED_STORAGE) === "true",
    };
  } catch {
    return null;
  }
}

export function storeTrialKey(apiKey: string, agentName: string): void {
  if (typeof window === "undefined" || typeof apiKey !== "string" || !apiKey.startsWith("pm_")) return;
  try {
    window.sessionStorage.setItem(TRIAL_KEY_STORAGE, apiKey);
    window.sessionStorage.setItem(TRIAL_AGENT_STORAGE, agentName);
    window.sessionStorage.setItem(TRIAL_HANDLED_STORAGE, "false");
  } catch {
    // The key remains visible in React state so the user can still copy or
    // download it when browser policy blocks session storage.
  }
}

export function markTrialKeyHandled(): void {
  if (typeof window !== "undefined") try {
    window.sessionStorage.setItem(TRIAL_HANDLED_STORAGE, "true");
  } catch {
    // UI state still records acknowledgement for the current page.
  }
}

export function clearStoredTrialKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(TRIAL_KEY_STORAGE);
    window.sessionStorage.removeItem(TRIAL_AGENT_STORAGE);
    window.sessionStorage.removeItem(TRIAL_HANDLED_STORAGE);
  } catch {
    // Clearing React state still hides the credential for the current page.
  }
}