import { RequestHandler } from "express";

export interface WalletSession {
  walletAddress: string;
}

export const isWalletAuthenticated: RequestHandler = (req: any, res, next) => {
  if (!req.session || !req.session.walletAddress) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req.walletAddress = req.session.walletAddress;
  next();
};

export function createWalletSession(req: any, walletAddress: string): Promise<void> {
  // AUTH-H01: regenerate session ID on authentication to prevent session fixation —
  // an attacker who captures a pre-auth cookie cannot reuse it after the victim logs in.
  return new Promise((resolve, reject) => {
    req.session.regenerate((err: any) => {
      if (err) return reject(err);
      req.session.walletAddress = walletAddress;
      req.session.save((saveErr: any) => {
        if (saveErr) {
          reject(saveErr);
        } else {
          resolve();
        }
      });
    });
  });
}

export function destroyWalletSession(req: any): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err: any) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
