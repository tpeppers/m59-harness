// Stopping a keeper process must not log a shared native client out. Survival relogs
// still call M59Client.close()/attachedLogoff explicitly at their existing call sites.
export function disconnectKeeperClient(client) {
  if (!client) return;
  if (client.attach) {
    client.stopKeepalive?.();
    client.sock?.destroy?.();
    return;
  }
  client.close?.();
}
