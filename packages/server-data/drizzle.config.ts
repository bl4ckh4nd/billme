import type { Config } from "drizzle-kit";

export default {
  schema: "./src/postgres/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://billme:billme@localhost:5432/billme",
  },
} satisfies Config;
