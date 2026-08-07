import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle";
import type { AppSettings } from "@billme/desktop-core/types";
import { strictJsonParse, SettingsSchema } from "./validation-schemas";
import { logger } from "@billme/desktop-core/utils/logger";

const normalizeSettings = (settings: unknown): AppSettings => {
  const next = settings as Partial<AppSettings>;
  // Backward compatibility for older saved settings that predate the portal section.
  if (!next.portal) {
    next.portal = { baseUrl: "" };
  } else if (typeof next.portal.baseUrl !== "string") {
    next.portal.baseUrl = "";
  }
  if (!next.eInvoice) {
    next.eInvoice = {
      enabled: false,
      standard: "zugferd-en16931",
      profile: "EN16931",
      version: "2.3",
    };
  } else {
    if (typeof next.eInvoice.enabled !== "boolean") {
      next.eInvoice.enabled = false;
    }
    if (next.eInvoice.standard !== "zugferd-en16931") {
      next.eInvoice.standard = "zugferd-en16931";
    }
    if (next.eInvoice.profile !== "EN16931") {
      next.eInvoice.profile = "EN16931";
    }
    if (next.eInvoice.version !== "2.3") {
      next.eInvoice.version = "2.3";
    }
  }
  // Backward compatibility for email section.
  if (!next.email) {
    next.email = {
      provider: "none",
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      fromName: "",
      fromEmail: "",
    };
  }
  // Backward compatibility for numbering section.
  if (!next.numbers) {
    next.numbers = {
      invoicePrefix: "RE-%Y-",
      nextInvoiceNumber: 1,
      numberLength: 3,
      offerPrefix: "ANG-%Y-",
      nextOfferNumber: 1,
      customerPrefix: "KD-",
      nextCustomerNumber: 1,
      customerNumberLength: 4,
    };
  } else {
    if (typeof next.numbers.customerPrefix !== "string") {
      next.numbers.customerPrefix = "KD-";
    }
    if (
      typeof next.numbers.nextCustomerNumber !== "number" ||
      !Number.isFinite(next.numbers.nextCustomerNumber)
    ) {
      next.numbers.nextCustomerNumber = 1;
    }
    if (
      typeof next.numbers.customerNumberLength !== "number" ||
      !Number.isFinite(next.numbers.customerNumberLength)
    ) {
      next.numbers.customerNumberLength = 4;
    }
  }
  // Backward compatibility for automation section.
  if (!next.automation) {
    next.automation = {
      dunningEnabled: false,
      dunningRunTime: "09:00",
      recurringEnabled: false,
      recurringRunTime: "03:00",
    };
  } else {
    if (typeof next.automation.recurringEnabled !== "boolean") {
      next.automation.recurringEnabled = false;
    }
    if (typeof next.automation.recurringRunTime !== "string") {
      next.automation.recurringRunTime = "03:00";
    }
  }
  // Backward compatibility for dashboard section.
  if (!next.dashboard) {
    next.dashboard = {
      monthlyRevenueGoal: 30000,
      dueSoonDays: 7,
      topCategoriesLimit: 5,
      recentPaymentsLimit: 5,
      topClientsLimit: 5,
    };
  }
  // Backward compatibility for dunning level enabled field.
  if (next.dunning?.levels) {
    next.dunning.levels = next.dunning.levels.map((level: any) => ({
      ...level,
      enabled: level.enabled !== undefined ? level.enabled : true,
    }));
  }
  return next as AppSettings;
};

export const getSettings = (db: Database.Database): AppSettings | null => {
  const row = createDrizzle(db)
    .select({ settingsJson: schema.settings.settingsJson })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1))
    .get();
  if (!row) return null;
  try {
    const parsed = strictJsonParse(
      row.settingsJson,
      SettingsSchema,
      "Application settings",
    );
    return normalizeSettings(parsed);
  } catch (error) {
    logger.error(
      "SettingsRepo",
      "Failed to parse settings, returning null",
      error as Error,
    );
    return null;
  }
};

export const setSettings = (
  db: Database.Database,
  settings: AppSettings,
): void => {
  createDrizzle(db)
    .insert(schema.settings)
    .values({ id: 1, settingsJson: JSON.stringify(settings) })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: { settingsJson: JSON.stringify(settings) },
    })
    .run();
};

export const setLastRecurringRun = (
  db: Database.Database,
  timestamp: string,
): void => {
  const row = createDrizzle(db)
    .select({ settingsJson: schema.settings.settingsJson })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1))
    .get();
  if (!row) return;
  const parsed = JSON.parse(row.settingsJson) as Record<string, any>;
  parsed.automation = {
    ...(parsed.automation ?? {}),
    lastRecurringRun: timestamp,
  };
  createDrizzle(db)
    .update(schema.settings)
    .set({ settingsJson: JSON.stringify(parsed) })
    .where(eq(schema.settings.id, 1))
    .run();
};
