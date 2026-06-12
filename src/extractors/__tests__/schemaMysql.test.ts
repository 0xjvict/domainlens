import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { extractSchema } from '../schema.js';
import type { DomainLensConfig } from '../../types.js';

function makeConfig(overrides: Partial<DomainLensConfig> = {}): DomainLensConfig {
  return {
    db_url_env: 'TEST_DATABASE_URL',
    llm_key_env: 'OPENROUTER_API_KEY',
    llm_model: 'anthropic/claude-haiku-4-5',
    code_paths: ['src/', 'app/'],
    docs_paths: ['docs/', 'README.md'],
    ignore: ['node_modules', '.git', 'dist'],
    ...overrides,
  };
}

describe('MySQL schema extraction — error handling', () => {
  const ENV_KEY = 'TEST_DATABASE_URL';

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('returns null without throwing when db_type=mysql and no DATABASE_URL set', async () => {
    const config = makeConfig({ db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null without throwing when db_type=mysql and empty DATABASE_URL', async () => {
    process.env[ENV_KEY] = '';
    const config = makeConfig({ db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null without throwing when no db_type and no DATABASE_URL', async () => {
    const config = makeConfig();
    const result = await extractSchema(config, '/tmp/nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when DATABASE_URL is unreachable (invalid host)', async () => {
    process.env[ENV_KEY] = 'mysql://invalid-host:3306/testdb';
    const config = makeConfig({ db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');
    expect(result).toBeNull();
  });

  it('infers mysql from URL protocol and returns null when unreachable', async () => {
    process.env[ENV_KEY] = 'mysql://localhost:13306/testdb';
    const config = makeConfig();
    const result = await extractSchema(config, '/tmp/nonexistent');
    expect(result).toBeNull();
  });
});

describe.runIf(process.env.RUN_INTEGRATION_TESTS)('MySQL schema extraction — integration', () => {
  let container: any;
  let connectionString: string;

  beforeAll(async () => {
    const { MySqlContainer } = await import('@testcontainers/mysql');
    container = await new MySqlContainer('mysql:8')
      .withDatabase('testdb')
      .withUsername('test')
      .withUserPassword('test')
      .start();

    connectionString = container.getConnectionUri();

    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(connectionString);

    await conn.query(`
      CREATE TABLE customers (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE,
        status ENUM('active', 'inactive', 'churned') DEFAULT 'active',
        score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT score_check CHECK (score >= 0)
      )
    `);

    await conn.query(`
      CREATE TABLE orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        customer_id INT NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
        CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
      )
    `);

    await conn.query(`ALTER TABLE customers ADD INDEX idx_customers_status (status)`);
    await conn.query(`ALTER TABLE customers ADD UNIQUE INDEX idx_customers_email_unique (email)`);

    await conn.end();
  });

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('extracts tables correctly', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    expect(result).not.toBeNull();
    expect(result!.tables.length).toBe(2);

    const tableNames = result!.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(['customers', 'orders']);
  });

  it('extracts columns with types, nullable, defaults, and comments', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const customers = result!.tables.find((t) => t.name === 'customers')!;

    expect(customers).toBeDefined();

    const idCol = customers.columns.find((c) => c.name === 'id')!;
    expect(idCol.nullable).toBe(false);
    expect(idCol.default).toBeNull();

    const nameCol = customers.columns.find((c) => c.name === 'name')!;
    expect(nameCol.type).toBe('varchar');
    expect(nameCol.nullable).toBe(false);

    const statusCol = customers.columns.find((c) => c.name === 'status')!;
    expect(statusCol.type).toContain('enum');

    const scoreCol = customers.columns.find((c) => c.name === 'score')!;
    expect(scoreCol.default).toBe('0');
  });

  it('extracts primary keys', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const customers = result!.tables.find((t) => t.name === 'customers')!;
    expect(customers.primary_keys).toEqual(['id']);

    const orders = result!.tables.find((t) => t.name === 'orders')!;
    expect(orders.primary_keys).toEqual(['id']);
  });

  it('extracts foreign keys', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const orders = result!.tables.find((t) => t.name === 'orders')!;
    const fk = orders.foreign_keys.find((fk) => fk.column === 'customer_id');
    expect(fk).toBeDefined();
    expect(fk!.references_table).toBe('customers');
    expect(fk!.references_column).toBe('id');
  });

  it('extracts indexes', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const customers = result!.tables.find((t) => t.name === 'customers')!;
    const idx = customers.indexes.find((i) => i.columns.includes('status'));
    expect(idx).toBeDefined();
  });

  it('extracts CHECK constraints', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const customers = result!.tables.find((t) => t.name === 'customers')!;
    const check = customers.check_constraints.find((c) => c.definition.includes('score'));
    expect(check).toBeDefined();
  });

  it('extracts UNIQUE constraints', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    const customers = result!.tables.find((t) => t.name === 'customers')!;
    const hasEmailUnique = customers.unique_constraints.some((u) =>
      u.columns.includes('email')
    );
    expect(hasEmailUnique).toBe(true);
  });

  it('extracts ENUM columns', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    expect(result!.enums.length).toBeGreaterThanOrEqual(2);

    const customerStatus = result!.enums.find((e) => e.name === 'customers.status');
    expect(customerStatus).toBeDefined();
    expect(customerStatus!.values).toEqual(['active', 'inactive', 'churned']);
  });

  it('sets schema field from database name', async () => {
    process.env.TEST_DATABASE_URL = connectionString;
    const config = makeConfig({ db_url_env: 'TEST_DATABASE_URL', db_type: 'mysql' });
    const result = await extractSchema(config, '/tmp/nonexistent');

    for (const table of result!.tables) {
      expect(table.schema).toBe('testdb');
    }
  });
});
