import type Database from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import type { Article } from "@billme/desktop-core/types";
import { createDrizzle, schema } from "./drizzle";

export const listArticles = (db: Database.Database): Article[] => {
  const rows = createDrizzle(db)
    .select()
    .from(schema.articles)
    .orderBy(asc(schema.articles.title))
    .all();
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku ?? undefined,
    title: r.title,
    description: r.description,
    price: r.price,
    unit: r.unit,
    category: r.category,
    taxRate: r.taxRate,
  }));
};

export const upsertArticle = (
  db: Database.Database,
  article: Article,
): Article => {
  createDrizzle(db)
    .insert(schema.articles)
    .values({
      id: article.id,
      sku: article.sku ?? null,
      title: article.title,
      description: article.description,
      price: article.price,
      unit: article.unit,
      category: article.category,
      taxRate: article.taxRate,
    })
    .onConflictDoUpdate({
      target: schema.articles.id,
      set: {
        sku: article.sku ?? null,
        title: article.title,
        description: article.description,
        price: article.price,
        unit: article.unit,
        category: article.category,
        taxRate: article.taxRate,
      },
    })
    .run();
  return article;
};

export const deleteArticle = (db: Database.Database, id: string): void => {
  createDrizzle(db)
    .delete(schema.articles)
    .where(eq(schema.articles.id, id))
    .run();
};
