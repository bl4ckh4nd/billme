import type Database from 'better-sqlite3';
import type { Article } from '../types';

type ArticleRow = {
  id: string;
  sku: string | null;
  title: string;
  description: string;
  price: number;
  unit: string;
  category: string;
  tax_rate: number;
};

export const listArticles = (db: Database.Database): Article[] => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY title ASC').all() as ArticleRow[];
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku ?? undefined,
    title: r.title,
    description: r.description,
    price: r.price,
    unit: r.unit,
    category: r.category,
    taxRate: r.tax_rate,
  }));
};

export const upsertArticle = (db: Database.Database, article: Article): Article => {
  const exists = db.prepare('SELECT 1 FROM articles WHERE id = ?').get(article.id) as
    | { 1: 1 }
    | undefined;

  if (!exists) {
    db.prepare(
      `
        INSERT INTO articles (id, sku, title, description, price, unit, category, tax_rate)
        VALUES (@id, @sku, @title, @description, @price, @unit, @category, @taxRate)
      `,
    ).run({
      id: article.id,
      sku: article.sku ?? null,
      title: article.title,
      description: article.description,
      price: article.price,
      unit: article.unit,
      category: article.category,
      taxRate: article.taxRate,
    });
  } else {
    db.prepare(
      `
        UPDATE articles SET
          sku=@sku,
          title=@title,
          description=@description,
          price=@price,
          unit=@unit,
          category=@category,
          tax_rate=@taxRate
        WHERE id=@id
      `,
    ).run({
      id: article.id,
      sku: article.sku ?? null,
      title: article.title,
      description: article.description,
      price: article.price,
      unit: article.unit,
      category: article.category,
      taxRate: article.taxRate,
    });
  }

  return article;
};

export const deleteArticle = (db: Database.Database, id: string): void => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
};
