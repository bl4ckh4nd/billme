import fs from 'fs';
import path from 'path';
import { app } from 'electron';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
}

class Logger {
  private logDir: string;
  private logFile: string;
  private isDev: boolean;

  constructor() {
    this.isDev = process.env.NODE_ENV !== 'production';

    // In test environment, use a temporary directory
    try {
      this.logDir = path.join(app.getPath('userData'), 'logs');
    } catch {
      // Fallback for test environment where app is not available
      this.logDir = path.join(process.cwd(), '.test-logs');
    }

    this.logFile = path.join(this.logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
    this.ensureLogDir();
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private write(level: LogLevel, context: string, message: string, data?: unknown, error?: Error) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      data,
      error: error ? { message: error.message, stack: error.stack } : undefined,
    };

    // Console output in development
    if (this.isDev) {
      const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[0m';
      console.log(`${color}[${level.toUpperCase()}] [${context}] ${message}\x1b[0m`, data || '');
      if (error) console.error(error);
    }

    // File output always
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (writeError) {
      // Fallback to console if file writing fails
      console.error('Failed to write to log file:', writeError);
      console.error('Original log entry:', entry);
    }
  }

  debug(context: string, message: string, data?: unknown) {
    if (this.isDev) this.write('debug', context, message, data);
  }

  info(context: string, message: string, data?: unknown) {
    this.write('info', context, message, data);
  }

  warn(context: string, message: string, data?: unknown) {
    this.write('warn', context, message, data);
  }

  error(context: string, message: string, error?: Error, data?: unknown) {
    this.write('error', context, message, data, error);
  }
}

export const logger = new Logger();
