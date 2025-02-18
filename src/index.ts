import { handleHttpRequest } from './handlers/http';
import { logger } from './core/logger';
import * as Sentry from '@sentry/node';

export interface Env {
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
  SENTRY_RELEASE: string;
  GITHUB_APP_TOKEN: string;  // GitHub App installation token for authentication
}

// Initialize Sentry
const initSentry = (env: Env) => {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
    ],
    tracesSampleRate: 1.0,
  });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      initSentry(env);
      return await handleHttpRequest(request, env, ctx);
    } catch (error) {
      logger.error('Unhandled error in fetch handler:', error);
      Sentry.captureException(error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
}; 