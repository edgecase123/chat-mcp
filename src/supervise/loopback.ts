/**
 * 🛑 LOOPBACK IS NOT THE BOUNDARY. A container reaches a host `127.0.0.1` bind
 * through `host.docker.internal` on Docker Desktop, measured. The token is what
 * separates callers; this only keeps a host listener off the operator's LAN.
 *
 * Extracted rather than copied, so the warning above cannot drift between the
 * two host listeners that share it — `CommandBroker` and `McpHttpListener`.
 */
export const BIND_ADDRESS = '127.0.0.1';
