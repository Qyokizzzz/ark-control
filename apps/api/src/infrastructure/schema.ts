import type { Pool, RowDataPacket } from 'mysql2/promise';

export async function ensureResourceSchema(pool: Pool) {
  const [columns] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='resources'",
  );
  const existing = new Set(columns.map((item) => String(item.name)));
  if (!existing.has('workspace_id')) {
    const [legacy] = await pool.query<RowDataPacket[]>('SELECT id FROM resources LIMIT 1');
    if (legacy.length)
      throw new Error('多工作空间版本需要一个空的后台数据库。请配置新的 DATABASE_NAME。');
    await pool.execute(
      "ALTER TABLE resources ADD COLUMN workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '' FIRST, DROP PRIMARY KEY, ADD PRIMARY KEY(workspace_id,kind,id)",
    );
  }
  const definitions: Record<string, string> = {
    revision: 'revision BIGINT NOT NULL DEFAULT 1',
    updated_at: 'updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
    state:
      "state VARCHAR(24) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(body, '$.status'))) STORED",
    due_at:
      "due_at VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(body, '$.nextAttemptAt'))) STORED",
  };
  for (const [name, definition] of Object.entries(definitions))
    if (!existing.has(name)) await pool.execute(`ALTER TABLE resources ADD COLUMN ${definition}`);
  const [indexes] = await pool.query<RowDataPacket[]>(
    "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='resources'",
  );
  const knownIndexes = new Set(indexes.map((item) => String(item.name)));
  if (!knownIndexes.has('idx_workspace_state'))
    await pool.execute(
      'ALTER TABLE resources ADD INDEX idx_workspace_state(workspace_id,kind,state,due_at)',
    );
  if (!knownIndexes.has('idx_workspace_updated'))
    await pool.execute(
      'ALTER TABLE resources ADD INDEX idx_workspace_updated(workspace_id,kind,updated_at)',
    );
  if (!knownIndexes.has('idx_public_resource'))
    await pool.execute('ALTER TABLE resources ADD INDEX idx_public_resource(kind,id)');
}
