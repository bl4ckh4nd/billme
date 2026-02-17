import nodemailer from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';
import { withRetry, shouldRetryNetworkError } from '../utils/retry';
import { logger } from '../utils/logger';

// Rate limiting state
let lastEmailSent = 0;
const MIN_DELAY_MS = 1000; // 1 second between emails

const enforceRateLimit = async (): Promise<void> => {
  const now = Date.now();
  const elapsed = now - lastEmailSent;
  if (elapsed < MIN_DELAY_MS && lastEmailSent > 0) {
    const delay = MIN_DELAY_MS - elapsed;
    logger.debug('EmailService', `Rate limiting: waiting ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

export interface EmailOptions {
  from: {
    name: string;
    email: string;
  };
  to: {
    name: string;
    email: string;
  };
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path: string;
  }>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true for 465, false for other ports
  auth: {
    user: string;
    pass: string;
  };
}

export interface ResendConfig {
  apiKey: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send email via SMTP (Nodemailer)
 */
export const sendViaSMTP = async (
  config: SmtpConfig,
  options: EmailOptions,
): Promise<EmailResult> => {
  await enforceRateLimit();

  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.auth.user,
        pass: config.auth.pass,
      },
    });

    // Verify connection
    await transporter.verify();

    // Prepare attachments
    const attachments: Attachment[] = (options.attachments ?? []).map((att) => ({
      filename: att.filename,
      path: att.path,
    }));

    // Send email with retry logic
    const info = await withRetry(
      () => transporter.sendMail({
        from: `"${options.from.name}" <${options.from.email}>`,
        to: `"${options.to.name}" <${options.to.email}>`,
        subject: options.subject,
        text: options.text,
        html: options.html ?? options.text.replace(/\n/g, '<br>'),
        attachments,
      }),
      {
        maxAttempts: 3,
        delayMs: 2000,
        shouldRetry: shouldRetryNetworkError,
        context: 'EmailService:SMTP',
      }
    );

    lastEmailSent = Date.now();
    logger.info('EmailService', 'Email sent successfully via SMTP', { to: options.to.email });

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('EmailService', 'Failed to send email via SMTP', error as Error, { to: options.to.email });
    return {
      success: false,
      error: message,
    };
  }
};

/**
 * Send email via Resend API
 */
export const sendViaResend = async (
  config: ResendConfig,
  options: EmailOptions,
): Promise<EmailResult> => {
  await enforceRateLimit();

  try {
    const fs = await import('fs/promises');

    // Prepare attachments for Resend
    const attachments = await Promise.all(
      (options.attachments ?? []).map(async (att) => {
        const content = await fs.readFile(att.path, { encoding: 'base64' });
        return {
          filename: att.filename,
          content,
        };
      }),
    );

    // Make API request to Resend with retry logic
    const response = await withRetry(
      () => fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          from: `${options.from.name} <${options.from.email}>`,
          to: [`${options.to.name} <${options.to.email}>`],
          subject: options.subject,
          text: options.text,
          html: options.html ?? options.text.replace(/\n/g, '<br>'),
          attachments,
        }),
      }),
      {
        maxAttempts: 3,
        delayMs: 1000,
        shouldRetry: (error) => {
          // Retry on network errors and 5xx server errors
          if (shouldRetryNetworkError(error)) return true;
          if (error instanceof Response) return error.status >= 500;
          return false;
        },
        context: 'EmailService:Resend',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('EmailService', 'Resend API returned error', undefined, {
        status: response.status,
        error: errorText
      });
      return {
        success: false,
        error: `Resend API error: ${response.status} - ${errorText}`,
      };
    }

    const result = (await response.json()) as { id: string };

    lastEmailSent = Date.now();
    logger.info('EmailService', 'Email sent successfully via Resend', { to: options.to.email });

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('EmailService', 'Failed to send email via Resend', error as Error, { to: options.to.email });
    return {
      success: false,
      error: message,
    };
  }
};

/**
 * Send email using the configured provider
 */
export const sendEmail = async (
  provider: 'smtp' | 'resend',
  providerConfig: SmtpConfig | ResendConfig,
  options: EmailOptions,
): Promise<EmailResult> => {
  if (provider === 'smtp') {
    return sendViaSMTP(providerConfig as SmtpConfig, options);
  } else {
    return sendViaResend(providerConfig as ResendConfig, options);
  }
};

/**
 * Test email configuration without sending an actual email
 */
export const testEmailConfig = async (
  provider: 'smtp' | 'resend',
  providerConfig: SmtpConfig | ResendConfig,
): Promise<EmailResult> => {
  if (provider === 'smtp') {
    const config = providerConfig as SmtpConfig;
    try {
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.auth.user,
          pass: config.auth.pass,
        },
      });

      // Verify connection without sending
      await transporter.verify();

      return {
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `SMTP-Verbindung fehlgeschlagen: ${message}`,
      };
    }
  } else {
    // Resend
    const config = providerConfig as ResendConfig;

    // Validate API key format
    if (!config.apiKey.startsWith('re_')) {
      return {
        success: false,
        error: 'Ungültiges Resend API-Key Format. Der Key muss mit "re_" beginnen.',
      };
    }

    try {
      // Test with lightweight GET request to API keys endpoint
      const response = await fetch('https://api.resend.com/api-keys', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return {
            success: false,
            error: 'Resend API-Key ungültig oder nicht autorisiert.',
          };
        }
        const errorText = await response.text();
        return {
          success: false,
          error: `Resend API-Fehler: ${response.status} - ${errorText}`,
        };
      }

      return {
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Resend-Verbindung fehlgeschlagen: ${message}`,
      };
    }
  }
};
