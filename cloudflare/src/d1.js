export function d1(db) {
  return {
    get(sql, ...values) {
      return db.prepare(sql).bind(...values).first();
    },
    all(sql, ...values) {
      return db.prepare(sql).bind(...values).all().then(result => result.results || []);
    },
    run(sql, ...values) {
      return db.prepare(sql).bind(...values).run();
    },
    batch(statements) {
      return db.batch(statements);
    },
    statement(sql, ...values) {
      return db.prepare(sql).bind(...values);
    }
  };
}

export function placeholders(count) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Invalid placeholder count");
  return Array(count).fill("?").join(",");
}
