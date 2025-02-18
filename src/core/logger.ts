import * as Sentry from '@sentry/browser';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private logLevel: LogLevel = 'info';

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    const context = args.length > 0 ? args[0] : undefined;

    // Add breadcrumb for Sentry
    Sentry.addBreadcrumb({
      type: 'debug',
      category: 'log',
      message: logMessage,
      level: this.getSentryLevel(level),
      data: context as Record<string, unknown>,
    });

    // For errors, also capture them in Sentry
    if (level === 'error') {
      if (context instanceof Error) {
        Sentry.captureException(context, {
          extra: { message: logMessage }
        });
      } else {
        Sentry.captureMessage(logMessage, {
          level: 'error',
          extra: context as Record<string, unknown>,
        });
      }
    }
  }

  private getSentryLevel(level: LogLevel): Sentry.SeverityLevel {
    switch (level) {
      case 'debug':
        return 'debug';
      case 'info':
        return 'info';
      case 'warn':
        return 'warning';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.log('debug', message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.log('info', message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.log('warn', message, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.log('error', message, ...args);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }
}

export const logger = new Logger(); 