import { z } from 'zod';

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Small helper for building parameterised WHERE clauses safely. */
export class Where {
  private parts: string[] = [];
  readonly params: unknown[] = [];
  add(sqlWithPlaceholder: string, ...values: unknown[]): this {
    let sql = sqlWithPlaceholder;
    for (const v of values) {
      this.params.push(v);
      sql = sql.replace('?', `$${this.params.length}`);
    }
    this.parts.push(sql);
    return this;
  }
  next(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  toString(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}
