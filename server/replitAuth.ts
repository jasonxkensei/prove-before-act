import session from "express-session";
import connectPg from "connect-pg-simple";
import { logger } from "./logger";

export function getSession() {
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
    },
  });
}
