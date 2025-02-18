import { handleHttpRequest } from './handlers/http';
import { logger } from './core/logger';
import * as Sentry from '@sentry/browser';

export interface Env {
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
  SENTRY_RELEASE: string;
  GITHUB_APP_ID: string;      // GitHub App ID
  GITHUB_CLIENT_ID: string;   // GitHub App Client ID
  GITHUB_PRIVATE_KEY: string; // GitHub App private key for JWT signing
  GITHUB_CLIENT_SECRET: string; // GitHub App client secret
  GITHUB_WEBHOOK_SECRET: string; // Secret for webhook verification
}

// Initialize Sentry
const initSentry = (env: Env) => {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    beforeSend(event) {
      // Clean up sensitive data before sending to Sentry
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['x-github-token'];
      }
      return event;
    }
  });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      initSentry(env);
      return await handleHttpRequest(request, env, ctx);
    } catch (error) {
      logger.error('Unhandled error in fetch handler:', error);
      Sentry.captureException(error, {
        tags: {
          url: request.url,
          method: request.method,
        },
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
}; 