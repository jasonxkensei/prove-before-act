# Contributing to Prove Before Act

Thank you for your interest in contributing to Prove Before Act. This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Set up your environment: `cp .env.example .env` and fill in your credentials
5. Push the database schema: `npm run db:push`
6. Start the development server: `npm run dev`

## Development Workflow

### Branch Naming

Use descriptive branch names:
- `feature/agent-mcp-tools` for new features
- `fix/pdf-generation-error` for bug fixes
- `docs/api-reference-update` for documentation changes

### Code Style

- **TypeScript** is required for all new code (both frontend and backend).
- Follow the existing patterns in the codebase.
- Use Drizzle ORM for all database operations &mdash; never write raw SQL in application code.
- Use Zod schemas for request validation.
- Frontend components should use Shadcn/ui primitives where applicable.
- Include `data-testid` attributes on interactive and meaningful display elements.

### Commit Messages

Use clear, descriptive commit messages:
```
feat: add batch certification endpoint for agents
fix: correct PDF QR code alignment on certificate
docs: update API reference with new ACP endpoints
```

### Pull Requests

1. Ensure your code passes TypeScript checks: `npm run check`
2. Test your changes locally with `npm run dev`
3. Write a clear PR description explaining:
   - What the change does
   - Why it is needed
   - How it was tested
4. Reference any related issues

## Architecture Guidelines

- **Backend routes** go in `server/routes.ts`. Database access uses Drizzle ORM directly (`db.select()`, `db.insert()`, etc.).
- **Database schema** changes go in `shared/schema.ts`. Always create insert schemas with `createInsertSchema`.
- **Frontend pages** go in `client/src/pages/`. Register routes in `client/src/App.tsx`.
- **Client utilities** go in `client/src/lib/`.
- **Blockchain interactions** go in `server/blockchain.ts` (server) or `client/src/lib/multiversxTransaction.ts` (client).

## AI Agent Endpoints

When adding or modifying agent-facing endpoints, ensure:

1. The OpenAPI spec at `/api/acp/openapi.json` is updated.
2. The MCP manifest at `/.well-known/mcp.json` reflects any new tools.
3. LangChain and CrewAI tool definitions are updated if applicable.
4. The `llms.txt` and `llms-full.txt` summaries remain accurate.

## Reporting Issues

- Use GitHub Issues for bugs and feature requests.
- Include steps to reproduce for bugs.
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be subject to the same license as the project (currently proprietary &mdash; All Rights Reserved).
