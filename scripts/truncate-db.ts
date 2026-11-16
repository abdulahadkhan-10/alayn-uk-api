import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Connecting to database...');

  // 1. Fetch all table names in public schema, excluding Prisma's migration history
  const tables: Array<{ tablename: string }> = await prisma.$queryRawUnsafe(`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename != '_prisma_migrations';
  `);

  if (!tables || tables.length === 0) {
    console.log('⚠️ No user tables found in database.');
    return;
  }

  console.log(`📋 Found ${tables.length} tables to truncate:`);

  // Count rows before truncate
  let totalRowsBefore = 0;
  for (const { tablename } of tables) {
    try {
      const countRes: Array<{ count: string | number | bigint }> = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as count FROM "${tablename}";`
      );
      const rowCount = Number(countRes[0]?.count ?? 0);
      if (rowCount > 0) {
        console.log(`   - "${tablename}": ${rowCount} rows`);
        totalRowsBefore += rowCount;
      }
    } catch (err: any) {
      console.warn(`   Could not count rows for "${tablename}":`, err.message);
    }
  }

  console.log(`\n📊 Total existing records across all tables: ${totalRowsBefore}`);

  if (totalRowsBefore === 0) {
    console.log('ℹ️ Database is already empty! Truncating anyway to reset identities...');
  }

  // 2. Perform TRUNCATE TABLE ... RESTART IDENTITY CASCADE
  const quotedTableNames = tables.map((t) => `"${t.tablename}"`).join(', ');

  console.log('\n🧹 Truncating all tables with CASCADE and RESTART IDENTITY...');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quotedTableNames} RESTART IDENTITY CASCADE;`);

  console.log('✅ All tables successfully truncated.');

  // 3. Verification check
  let remainingRows = 0;
  for (const { tablename } of tables) {
    const countRes: Array<{ count: string | number | bigint }> = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM "${tablename}";`
    );
    const rowCount = Number(countRes[0]?.count ?? 0);
    remainingRows += rowCount;
  }

  console.log(`\n🎉 Verification complete: ${remainingRows} rows remaining in the database.`);
  console.log('✨ Database schema, triggers, and migrations are intact. All table data has been completely erased.');
}

main()
  .catch((e) => {
    console.error('❌ Error truncating database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
