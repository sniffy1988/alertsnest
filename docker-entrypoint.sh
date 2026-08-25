#!/bin/sh
set -eu
mkdir -p /data
npx prisma migrate deploy
exec node dist/main.js
