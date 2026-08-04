import session from "express-session";
import connectPg from "connect-pg-simple";
import { logger } from "./logger";

export function getSession() {
  // AUTH-H03: fail fast at startup if SESSION_SECRET is absent — express-session
  // receives undefined otherwise and may silently generate insecure sessions.
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required but not set. Set it before starting the server.");
  }

  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    tableName: "sessions",
  });
  const isProduction = process.env.NODE_ENV === "production";
  logger.info("Session config", { component: "auth", production: isProduction, secure: isProduction });

  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict",
      // AUTH-M05: bound session lifetime so abandoned sessions expire on the
      // server side even if the browser never sends a logout request.
      // 24 h matches the nativeAuth token expiry; rolling: true means active
      // users get a sliding window without being forced to re-authenticate.
      maxAge: 24 * 60 * 60 * 1000,
    },
    rolling: true,
  });
}
