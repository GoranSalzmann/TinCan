#!/bin/sh
# Drizzle's migration workflow for comparison: drizzle-kit generates SQL from
# the TS schema on every schema change; FTS5 needs a hand-written custom file.
set -e
SPIKE=$(cd "$(dirname "$0")/../.." && pwd)
W="$SPIKE/node_modules/.drizzle-demo"; rm -rf "$W"; mkdir -p "$W"  # inside node_modules so the schema resolves drizzle-orm
cp "$SPIKE/src/typed/drizzle-schema.ts" $W/schema.ts
cat > $W/drizzle.config.ts <<CFG
export default { dialect: "sqlite", schema: "./node_modules/.drizzle-demo/schema.ts", out: "./node_modules/.drizzle-demo/migrations" };
CFG
cd "$SPIKE"
echo "1. drizzle-kit generate (initial schema)"
/usr/bin/time -f "  generate took %e s" npx drizzle-kit generate --config $W/drizzle.config.ts --name init 2>&1 | grep -v -E "^$|Reading config|No config path" | sed 's/^/  /'
echo "2. drizzle-kit generate --custom for the FTS5 virtual table"
npx drizzle-kit generate --config $W/drizzle.config.ts --custom --name fts 2>&1 | grep -v -E "^$|Reading config" | sed 's/^/  /'
F=$(ls "$W"/migrations/*_fts.sql | head -1)
# the generated stub ends without a newline after its comment
printf '\n%s\n' "CREATE VIRTUAL TABLE message_fts USING fts5(content, channel_id UNINDEXED, message_id UNINDEXED);" >> "$F"
echo "  files:"; (cd $W/migrations && find . -type f | sort | sed 's/^/    /')
echo "3. apply with the runtime migrator (per-module tracking table)"
npx tsx src/migrate/drizzle-run.ts $W/app.db $W/migrations __drizzle_migrations_text_chat
echo "4. schema change: add message.pinned_at, regenerate"
sed -i 's|  flags: integer("flags").notNull().default(0),|  flags: integer("flags").notNull().default(0),\n  pinnedAt: integer("pinned_at"),|' $W/schema.ts
npx drizzle-kit generate --config $W/drizzle.config.ts --name pinned 2>&1 | grep -v -E "^$|Reading config" | sed 's/^/  /'
echo "  generated SQL:"; cat "$W"/migrations/*_pinned.sql | sed 's/^/    /'; echo
npx tsx src/migrate/drizzle-run.ts $W/app.db $W/migrations __drizzle_migrations_text_chat
