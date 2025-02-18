# Cloudflare Worker Project

A TypeScript-based Cloudflare Worker project with Sentry integration for error tracking and logging.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `wrangler.toml`:
   - `SENTRY_DSN`: Your Sentry project DSN
   - `SENTRY_ENVIRONMENT`: Environment name (e.g., "development", "production")
   - `SENTRY_RELEASE`: Version of your application
   - Other API keys as needed

3. Development:
```bash
npm run dev
```

4. Deploy:
```bash
npm run deploy
```

## Logging

This project uses Sentry for error tracking and logging. The logging utility (`src/core/logger.ts`) provides the following methods:

- `logger.debug(message, ...args)`
- `logger.info(message, ...args)`
- `logger.warn(message, ...args)`
- `logger.error(message, ...args)`

Example usage:
```typescript
import { logger } from './core/logger';

try {
  // Your code here
} catch (error) {
  logger.error('Operation failed', error);
}
```

All logs are sent to Sentry with appropriate severity levels and include:
- Timestamp
- Log level
- Message
- Additional context (if provided)

Error logs automatically:
- Create Sentry breadcrumbs
- Capture exceptions (if the argument is an Error object)
- Capture messages with context (for non-Error objects)

## Environment Variables

Required environment variables:
- `SENTRY_DSN`: Sentry project DSN
- `SENTRY_ENVIRONMENT`: Environment name
- `SENTRY_RELEASE`: Application version
- `CLAUDE_API_KEY`: API key for Claude service
- `GITHUB_TOKEN`: GitHub API token
- `BRAVE_API_KEY`: Brave API key

## Development

- TypeScript for type safety
- ESLint for code linting
- Prettier for code formatting
- Jest for testing 