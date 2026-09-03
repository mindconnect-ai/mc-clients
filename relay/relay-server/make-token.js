#!/usr/bin/env node
// Usage: node make-token.js <RELAY_SECRET> <serverId>
// Prints the SERVER_TOKEN the connector authenticates with.
import { serverToken } from './tokens.js';

const [secret, serverId] = process.argv.slice(2);
if (!secret || !serverId) {
  console.error('Usage: node make-token.js <RELAY_SECRET> <serverId>');
  process.exit(1);
}
console.log(serverToken(secret, serverId));
