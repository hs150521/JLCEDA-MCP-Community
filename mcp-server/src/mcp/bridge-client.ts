import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export function formatInternalClientEndpoint(port: number): string {
  return `ws://127.0.0.1:${String(port)}/mcp-internal`;
}

interface BridgePeer {
  clientId: string;
  bridgeVersion: string;
  connectedAt: number;
  context?: BridgeClientContext;
  isReady: boolean;
  lastSeenAt: number;
  socket: WebSocket;
}

interface BridgeClientContext {
  documentType?: number;
  documentUuid?: string;
  tabId?: string;
  projectUuid?: string;
  projectName?: string;
  pageKind?: 'schematic' | 'pcb';
  pageUuid?: string;
  pageName?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  executionTimeoutMs?: number;
  started?: boolean;
  clientId?: string;
  leaseTerm?: number;
  mcpSocket?: WebSocket;
  edaSocket?: WebSocket;
  path?: string;
  payload?: unknown;
  startedAt?: number;
  context?: BridgeClientContext;
}

interface RecoveryDiagnostic {
  requestId: string;
  clientId: string;
  path: string;
  startedAt: string;
  timeoutMs: number;
  timedOutAtMs: number;
  mutating: boolean;
  context?: BridgeClientContext;
}

interface RecoverySession {
  recoveryId: string;
  diagnostic: RecoveryDiagnostic;
  requestedAt: string;
  requestedAtMs: number;
  sourceConnected: boolean;
  targetClientId?: string;
}

interface BridgeTask {
  type: 'bridge/task';
  requestId: string;
  path: string;
  payload: unknown;
  timeoutMs: number;
}

const BRIDGE_QUEUE_TIMEOUT_MS = 15 * 60 * 1000;
const RECOVERY_READBACK_TIMEOUT_MS = 15_000;
const RECOVERY_DIAGNOSTIC_TTL_MS = 15 * 60 * 1000;
const READ_ONLY_PATHS = new Set([
  '/bridge/jlceda/context',
  '/bridge/jlceda/schematic/read',
  '/bridge/jlceda/schematic/review',
  '/bridge/jlceda/schematic/drc-check',
  '/bridge/jlceda/schematic/layout-check',
  '/bridge/jlceda/pcb/drc-check',
  '/bridge/jlceda/canvas/snapshot',
  '/bridge/jlceda/project/info',
  '/bridge/jlceda/design/source-export',
  '/bridge/jlceda/design/archive-export',
  '/bridge/jlceda/library/search',
  '/bridge/jlceda/library/preview',
  '/bridge/jlceda/library/sources',
  '/bridge/jlceda/library/classification-query',
  '/bridge/jlceda/workspace/query',
  '/bridge/jlceda/net/query-pcb',
  '/bridge/jlceda/pcb/layer-query',
  '/bridge/jlceda/pcb/constraints-query',
  '/bridge/jlceda/manufacture/templates-query',
  '/bridge/jlceda/netlist/compare',
  '/bridge/jlceda/design/compare',
]);

function isReadOnlyRequest(path: string, payload: unknown): boolean {
  if (!READ_ONLY_PATHS.has(path)) {
    return false;
  }
  return path !== '/bridge/jlceda/schematic/layout-check'
    || !isRecord(payload)
    || payload.mode !== 'fix';
}

function hasMutatingRecoveryDiagnostics(diagnostics: Iterable<RecoveryDiagnostic>): boolean {
  for (const diagnostic of diagnostics) {
    if (diagnostic.mutating) {
      return true;
    }
  }
  return false;
}

interface BridgeServerOptions {
  peerTtlMs?: number;
  peerSweepIntervalMs?: number;
}

function decodeMessage(data: RawData): unknown {
  if (Buffer.isBuffer(data)) {
    return JSON.parse(data.toString('utf8'));
  }
  if (Array.isArray(data)) {
    return JSON.parse(Buffer.concat(data).toString('utf8'));
  }
  return JSON.parse(Buffer.from(data).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not open');
  }
  socket.send(JSON.stringify(message));
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function parseClientContext(value: unknown): BridgeClientContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pageKind = value.pageKind === 'schematic' || value.pageKind === 'pcb'
    ? value.pageKind
    : undefined;
  const documentType = typeof value.documentType === 'number' && Number.isFinite(value.documentType)
    ? value.documentType
    : undefined;
  return {
    documentType,
    documentUuid: optionalString(value.documentUuid),
    tabId: optionalString(value.tabId),
    projectUuid: optionalString(value.projectUuid),
    projectName: optionalString(value.projectName),
    pageKind,
    pageUuid: optionalString(value.pageUuid),
    pageName: optionalString(value.pageName),
  };
}

function extractReadbackIdentity(value: unknown): { documentUuid?: string; projectUuid?: string } {
  if (!isRecord(value)) {
    return {};
  }
  const document = isRecord(value.currentDocumentInfo) ? value.currentDocumentInfo : isRecord(value.currentDocument) ? value.currentDocument : undefined;
  const project = isRecord(value.currentProjectInfo) ? value.currentProjectInfo : isRecord(value.project) ? value.project : undefined;
  return {
    documentUuid: optionalString(document?.uuid),
    projectUuid: optionalString(document?.parentProjectUuid) ?? optionalString(project?.uuid),
  };
}

export class EdaBridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly peers = new Map<string, BridgePeer>();
  private readonly clientIdBySocket = new Map<WebSocket, string>();
  private readonly mcpClients = new Set<WebSocket>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly reconnectBarriers = new Map<string, { path: string; until: number }>();
  private readonly recoveryDiagnostics = new Map<string, RecoveryDiagnostic>();
  private recoverySession: RecoverySession | undefined;
  private readonly instanceId = randomUUID();
  private requestIdCounter = 0;
  private activeClientId = '';
  private leaseTerm = 0;
  private started = false;
  private isMainServer = false;
  private internalClient: WebSocket | null = null;
  private readonly authToken = String(process.env.JLCEDA_BRIDGE_TOKEN ?? '').trim();
  private readonly peerTtlMs: number;
  private readonly peerSweepIntervalMs: number;
  private peerSweepTimer: NodeJS.Timeout | null = null;
  private promoting = false;
  private closing = false;

  public constructor(private readonly port: number = 8765, options: BridgeServerOptions = {}) {
    this.peerTtlMs = options.peerTtlMs ?? 15000;
    this.peerSweepIntervalMs = options.peerSweepIntervalMs ?? 1000;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.startAsMainServer();
    } catch (error) {
      process.stderr.write(`Failed to start as main server, trying client mode: ${String(error)}\n`);
      await this.startAsClient();
    }
    this.started = true;
  }

  private async startAsMainServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      this.wss = server;

      server.once('listening', () => {
        settled = true;
        this.isMainServer = true;
        process.stderr.write(`[Main Server] WebSocket server listening on ws://127.0.0.1:${this.port}\n`);
        if (!this.authToken) {
          process.stderr.write('[Security] JLCEDA_BRIDGE_TOKEN is not set; local WebSocket authentication is disabled\n');
        }
        this.startPeerSweep();
        resolve();
      });

      server.on('connection', (socket, request) => {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        const pathname = requestUrl.pathname;
        if (!this.isAuthorized(requestUrl)) {
          process.stderr.write(`[Main Server] Rejected unauthorized WebSocket connection on ${pathname}\n`);
          socket.close(1008, 'Unauthorized');
          return;
        }
        if (pathname === '/bridge/ws') {
          this.attachEdaSocket(socket);
          return;
        }
        if (pathname === '/mcp-internal') {
          this.attachMcpSocket(socket);
          return;
        }
        process.stderr.write(`[Main Server] Rejected unsupported WebSocket path: ${pathname}\n`);
        socket.close(1008, 'Unsupported WebSocket path');
      });

      server.on('error', (error) => {
        if (!settled) {
          this.wss = null;
          reject(error);
          return;
        }
        process.stderr.write(`WebSocket server error: ${error.message}\n`);
      });
    });
  }

  private async startAsClient(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tokenQuery = this.authToken ? `?token=${encodeURIComponent(this.authToken)}` : '';
      const url = `ws://127.0.0.1:${this.port}/mcp-internal${tokenQuery}`;
      const socket = new WebSocket(url);
      this.internalClient = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Connection to main server timeout'));
        }
      }, 5000);

      socket.on('message', (data) => {
        try {
          const message = decodeMessage(data);
          if (isRecord(message) && message.type === 'bridge/internal-ready' && !settled) {
            settled = true;
            clearTimeout(timer);
            process.stderr.write(`[Client Mode] Connected to main server at ${formatInternalClientEndpoint(this.port)}\n`);
            resolve();
            return;
          }
        } catch {
          // The regular message handler reports malformed payloads after authentication.
        }
        this.handleInternalMessage(data);
      });
      socket.on('close', () => {
        this.internalClient = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Main server closed before authentication completed'));
        }
        this.rejectAllPending('Main server connection closed');
        if (this.started && !this.closing && !this.promoting) {
          void this.recoverMainServer();
        }
      });
      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private isAuthorized(requestUrl: URL): boolean {
    if (!this.authToken) {
      return true;
    }
    return secureEquals(requestUrl.searchParams.get('token') ?? '', this.authToken);
  }

  private startPeerSweep(): void {
    if (this.peerSweepTimer) {
      clearInterval(this.peerSweepTimer);
    }
    this.peerSweepTimer = setInterval(() => this.expireStalePeers(), this.peerSweepIntervalMs);
    this.peerSweepTimer.unref();
  }

  private expireStalePeers(): void {
    const now = Date.now();
    for (const peer of [...this.peers.values()]) {
      if (now - peer.lastSeenAt <= this.peerTtlMs) {
        continue;
      }
      this.rejectPendingForClient(peer.clientId, 'EDA client heartbeat timed out');
      peer.socket.close(4000, 'Bridge heartbeat timeout');
      this.removeEdaSocket(peer.socket);
    }
  }

  private async recoverMainServer(): Promise<void> {
    if (this.promoting || this.closing) {
      return;
    }
    this.promoting = true;
    process.stderr.write('[Client Mode] Main server lost; attempting listener takeover\n');
    try {
      for (let attempt = 0; attempt < 20 && !this.closing; attempt += 1) {
        try {
          await this.startAsMainServer();
          process.stderr.write('[Client Mode] Promoted to main server\n');
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
          try {
            await this.startAsClient();
            return;
          } catch {
            // Another process may still be taking over. Retry until the deadline.
          }
        }
      }
      process.stderr.write('[Client Mode] Failed to recover a main bridge server\n');
    } finally {
      this.promoting = false;
    }
  }

  private attachEdaSocket(socket: WebSocket): void {
    socket.on('message', (data) => {
      try {
        this.handleEdaMessage(socket, decodeMessage(data));
      } catch (error) {
        this.trySend(socket, {
          type: 'bridge/error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.on('close', () => this.removeEdaSocket(socket));
    socket.on('error', () => this.removeEdaSocket(socket));
  }

  private handleEdaMessage(socket: WebSocket, rawMessage: unknown): void {
    if (!isRecord(rawMessage)) {
      throw new Error('Bridge message must be an object');
    }
    const type = String(rawMessage.type ?? '');
    if (type === 'bridge/hello') {
      const clientId = String(rawMessage.clientId ?? '').trim();
      if (!clientId) {
        throw new Error('bridge/hello requires clientId');
      }
      const peer = this.registerPeer(
        clientId,
        socket,
        optionalString(rawMessage.bridgeVersion) ?? 'unknown',
        parseClientContext(rawMessage.context),
      );
      this.trySend(socket, {
        type: 'bridge/welcome',
        clientId,
        connectedAt: new Date(peer.connectedAt).toISOString(),
      });
      this.trySend(socket, {
        type: 'bridge/debug-switch',
        clientId,
        debugSwitch: { enableSystemLog: false, enableConnectionList: false },
      });
      this.broadcastRoles('Client handshake completed');
      return;
    }

    const peer = this.getBoundPeer(socket, rawMessage.clientId);
    peer.lastSeenAt = Date.now();
    if (type === 'bridge/heartbeat') {
      peer.context = parseClientContext(rawMessage.context) ?? peer.context;
      this.trySend(socket, {
        type: 'bridge/heartbeat-ack',
        clientId: peer.clientId,
        sentAt: Number(rawMessage.sentAt ?? 0),
        receivedAt: new Date(peer.lastSeenAt).toISOString(),
      });
      return;
    }
    if (type === 'bridge/ready') {
      peer.isReady = true;
      return;
    }
    if (type === 'bridge/task-started') {
      this.markPendingRequestStarted(peer, rawMessage);
      return;
    }
    if (type === 'bridge/result') {
      this.completePendingRequest(peer, rawMessage);
      return;
    }
    if (type === 'bridge/log') {
      return;
    }
    throw new Error(`Unsupported bridge message type: ${type}`);
  }

  private registerPeer(
    clientId: string,
    socket: WebSocket,
    bridgeVersion: string,
    context: BridgeClientContext | undefined,
  ): BridgePeer {
    const previous = this.peers.get(clientId);
    if (previous && previous.socket !== socket) {
      this.enterReconnectBarrier(clientId);
      this.rejectPendingForClient(clientId, 'EDA client reconnected before the pending request completed');
      this.clientIdBySocket.delete(previous.socket);
      previous.socket.close(4001, 'Replaced by a newer connection');
    }
    const now = Date.now();
    const peer: BridgePeer = {
      clientId,
      bridgeVersion,
      connectedAt: previous?.connectedAt ?? now,
      context,
      isReady: previous?.socket === socket ? previous.isReady : false,
      lastSeenAt: now,
      socket,
    };
    this.peers.set(clientId, peer);
    this.clientIdBySocket.set(socket, clientId);
    if (!this.activeClientId || !this.peers.has(this.activeClientId)) {
      this.activeClientId = clientId;
      this.leaseTerm += 1;
    }
    return peer;
  }

  private getBoundPeer(socket: WebSocket, rawClientId: unknown): BridgePeer {
    const clientId = String(rawClientId ?? '').trim();
    const boundClientId = this.clientIdBySocket.get(socket);
    if (!clientId || clientId !== boundClientId) {
      throw new Error('Bridge client is not registered on this socket');
    }
    const peer = this.peers.get(clientId);
    if (!peer || peer.socket !== socket) {
      throw new Error('Bridge client registration is stale');
    }
    return peer;
  }

  private removeEdaSocket(socket: WebSocket): void {
    const clientId = this.clientIdBySocket.get(socket);
    if (!clientId) {
      return;
    }
    this.clientIdBySocket.delete(socket);
    const peer = this.peers.get(clientId);
    if (peer?.socket !== socket) {
      return;
    }
    this.peers.delete(clientId);
    if (this.activeClientId === clientId) {
      this.rejectPendingForClient(clientId, 'Active EDA client disconnected');
      const replacement = [...this.peers.values()].sort((left, right) => left.connectedAt - right.connectedAt)[0];
      this.activeClientId = replacement?.clientId ?? '';
      this.leaseTerm += 1;
      this.broadcastRoles('Active client disconnected; standby promoted');
    }
  }

  private broadcastRoles(reason: string): void {
    for (const peer of this.peers.values()) {
      this.trySend(peer.socket, {
        type: 'bridge/role',
        clientId: peer.clientId,
        role: peer.clientId === this.activeClientId ? 'active' : 'standby',
        leaseTerm: this.leaseTerm,
        activeClientId: this.activeClientId,
        reason,
      });
    }
  }

  private completePendingRequest(peer: BridgePeer, message: Record<string, unknown>): void {
    const requestId = String(message.requestId ?? '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.clientId !== peer.clientId || pending.edaSocket !== peer.socket || pending.leaseTerm !== Number(message.leaseTerm)) {
      // A timed-out EDA Promise can still send its result later. Seeing that
      // result is the only safe indication that the background mutation settled.
      const diagnostic = this.recoveryDiagnostics.get(requestId);
      if (diagnostic?.clientId === peer.clientId) {
        this.recoveryDiagnostics.delete(requestId);
      }
      return;
    }
    this.clearPendingTimeout(pending);
    this.pendingRequests.delete(requestId);
    if (isRecord(message.error) && typeof message.error.message === 'string') {
      pending.reject(new Error(message.error.message));
      return;
    }
    if (message.error) {
      pending.reject(new Error(String(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private markPendingRequestStarted(peer: BridgePeer, message: Record<string, unknown>): void {
    const requestId = String(message.requestId ?? '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.clientId !== peer.clientId || pending.edaSocket !== peer.socket || pending.leaseTerm !== Number(message.leaseTerm)) {
      return;
    }

    pending.started = true;
    pending.startedAt = Date.now();
    this.clearPendingTimeout(pending);
    const executionTimeoutMs = pending.executionTimeoutMs ?? 30000;
    pending.timeout = setTimeout(() => {
      // The EDA handler cannot be cancelled when the server-side timeout wins.
      // Keep this client quarantined for the execution window before admitting
      // another task that could mutate the same document.
      if (pending.clientId) {
        this.enterReconnectBarrier(pending.clientId);
        const diagnostic: RecoveryDiagnostic = {
          requestId,
          clientId: pending.clientId,
          path: pending.path ?? '/bridge/jlceda/unknown',
          startedAt: new Date(pending.startedAt ?? Date.now()).toISOString(),
          timeoutMs: executionTimeoutMs,
          timedOutAtMs: Date.now(),
          mutating: !isReadOnlyRequest(pending.path ?? '', pending.payload),
          context: pending.context,
        };
        this.recoveryDiagnostics.set(requestId, diagnostic);
      }
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(`Request execution timeout after ${String(executionTimeoutMs)}ms`));
    }, executionTimeoutMs);
  }

  private clearPendingTimeout(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
  }

  private attachMcpSocket(socket: WebSocket): void {
    this.mcpClients.add(socket);
    this.trySend(socket, { type: 'bridge/internal-ready' });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = decodeMessage(data);
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }
      if (!isRecord(message) || message.type !== 'bridge/task') {
        return;
      }
      const requestId = String(message.requestId ?? '');
      const path = String(message.path ?? '');
      const forwardedTimeoutMs = Number(message.timeoutMs);
      const timeoutMs = Number.isInteger(forwardedTimeoutMs) && forwardedTimeoutMs > 0
        ? forwardedTimeoutMs
        : 30000;
      void this.dispatchRequest(path, message.payload, timeoutMs, socket).then(
        (result) => this.trySend(socket, { type: 'bridge/result', requestId, result }),
        (error) => this.trySend(socket, {
          type: 'bridge/result',
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    const cleanupMcpSocket = (): void => {
      this.mcpClients.delete(socket);
      this.rejectPendingForMcpSocket(socket, 'MCP client disconnected while the request was pending');
    };
    socket.on('close', cleanupMcpSocket);
    socket.on('error', cleanupMcpSocket);
  }

  private handleInternalMessage(data: RawData): void {
    try {
      const message = decodeMessage(data);
      if (!isRecord(message) || message.type !== 'bridge/result') {
        return;
      }
      const requestId = String(message.requestId ?? '');
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      if (message.error) {
        pending.reject(new Error(String(message.error)));
      } else {
        pending.resolve(message.result);
      }
    } catch (error) {
      process.stderr.write(`Failed to parse message from main server: ${String(error)}\n`);
    }
  }

  public async request(path: string, payload: unknown, timeoutMs: number = 30000): Promise<unknown> {
    if (!this.started) {
      throw new Error('Bridge server not started');
    }
    if (!this.isMainServer) {
      return this.dispatchViaInternalClient(path, payload, timeoutMs);
    }
    return this.dispatchRequest(path, payload, timeoutMs);
  }

  private async dispatchRequest(path: string, payload: unknown, timeoutMs: number, mcpSocket?: WebSocket): Promise<unknown> {
    if (path === '/bridge/admin/clients') {
      return this.getClientSnapshot();
    }
    if (path === '/bridge/admin/select-client') {
      const clientId = isRecord(payload) ? String(payload.clientId ?? '').trim() : '';
      const force = isRecord(payload) && payload.force === true;
      return this.selectClient(clientId, force);
    }
    if (path === '/bridge/admin/recover-client') {
      return this.recoverClient(payload, timeoutMs);
    }
    return this.dispatchToEda(path, payload, timeoutMs, mcpSocket);
  }

  private getClientSnapshot(): Record<string, unknown> {
    this.pruneRecoveryDiagnostics();
    const now = Date.now();
    const clients = [...this.peers.values()]
      .sort((left, right) => left.connectedAt - right.connectedAt)
      .map((peer) => ({
        clientId: peer.clientId,
        active: peer.clientId === this.activeClientId,
        ready: peer.isReady && peer.socket.readyState === WebSocket.OPEN,
        bridgeVersion: peer.bridgeVersion,
        connectedAt: new Date(peer.connectedAt).toISOString(),
        lastSeenMsAgo: Math.max(0, now - peer.lastSeenAt),
        context: peer.context,
        quarantine: this.recoverySession?.targetClientId === peer.clientId
          ? { state: 'readback-required', recoveryId: this.recoverySession.recoveryId }
          : [...this.recoveryDiagnostics.values()].some(diagnostic => diagnostic.clientId === peer.clientId)
            ? {
              state: 'timed-out',
              diagnostics: [...this.recoveryDiagnostics.values()].filter(diagnostic => diagnostic.clientId === peer.clientId),
            }
            : undefined,
        }));
    const visibleClientIds = new Set(clients.map((client) => client.clientId));
    const disconnectedDiagnostics = new Map<string, RecoveryDiagnostic[]>();
    for (const diagnostic of this.recoveryDiagnostics.values()) {
      if (!visibleClientIds.has(diagnostic.clientId)) {
        const entries = disconnectedDiagnostics.get(diagnostic.clientId) ?? [];
        entries.push(diagnostic);
        disconnectedDiagnostics.set(diagnostic.clientId, entries);
      }
    }
    for (const [clientId, diagnostics] of disconnectedDiagnostics) {
      clients.push({
        clientId,
        active: false,
        ready: false,
        bridgeVersion: 'unknown',
        connectedAt: diagnostics[0].startedAt,
        lastSeenMsAgo: Math.max(0, now - diagnostics.reduce((earliest, diagnostic) => Math.min(earliest, diagnostic.timedOutAtMs), now)),
        context: diagnostics.find((diagnostic) => diagnostic.context)?.context,
        quarantine: { state: 'timed-out', diagnostics },
      });
    }
    return { activeClientId: this.activeClientId || null, leaseTerm: this.leaseTerm, clients };
  }

  private selectClient(clientId: string, force: boolean, allowRecoverySessionSwitch = false): Record<string, unknown> {
    if (!clientId) {
      throw new Error('clientId is required');
    }
    const peer = this.peers.get(clientId);
    if (!peer || !peer.isReady || peer.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`EDA client is not connected and ready: ${clientId}`);
    }
    if (this.recoverySession && this.activeClientId !== clientId && !allowRecoverySessionSwitch) {
      throw new Error(`Cannot switch EDA client while recovery ${this.recoverySession.recoveryId} is awaiting readback.`);
    }
    const hasPendingTask = [...this.pendingRequests.values()].some(
      (pending) => pending.clientId === this.activeClientId,
    );
    if (hasPendingTask && this.activeClientId !== clientId) {
      if (!force) {
        throw new Error('Cannot switch EDA client while the active client has a pending task');
      }
      this.rejectPendingForClient(this.activeClientId, `Active EDA client was force-switched to ${clientId}`);
    }
    if (this.activeClientId !== clientId) {
      this.activeClientId = clientId;
      this.leaseTerm += 1;
      this.broadcastRoles('Client explicitly selected by MCP');
    }
    return this.getClientSnapshot();
  }

  private async recoverClient(payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    this.pruneRecoveryDiagnostics();
    if (!isRecord(payload) || payload.confirm !== true) {
      throw new Error('bridge_recover_client requires confirm=true.');
    }
    const action = payload.action === undefined ? 'recover' : String(payload.action);
    if (action !== 'recover' && action !== 'readback') {
      throw new Error('bridge_recover_client action must be recover or readback.');
    }

    if (action === 'recover') {
      if (this.recoverySession) {
        throw new Error('A Bridge recovery is already awaiting readback.');
      }
      const requestId = String(payload.requestId ?? '').trim();
      if (!requestId) {
        throw new Error('bridge_recover_client action=recover requires the timed-out requestId from bridge_clients.');
      }
      const diagnostic = this.recoveryDiagnostics.get(requestId);
      if (!diagnostic)
        throw new Error(`No unresolved timeout diagnostic exists for requestId: ${requestId}`);
      const sourceClientId = diagnostic.clientId;
      if (!diagnostic.mutating) {
        throw new Error('The active timed-out task was read-only and does not require controlled mutation recovery.');
      }
      const source = this.peers.get(sourceClientId);
      const sourceConnected = Boolean(source?.isReady && source.socket.readyState === WebSocket.OPEN);
      const recoveryId = randomUUID();
      this.recoverySession = { recoveryId, diagnostic, requestedAt: new Date().toISOString(), requestedAtMs: Date.now(), sourceConnected };
      if (sourceConnected) {
        this.trySend(source!.socket, {
          type: 'bridge/recover',
          recoveryId,
          reason: `Controlled recovery after timed-out mutation ${diagnostic.requestId}`,
        });
      }
      return {
        ok: true,
        action,
        recoveryId,
        sourceClientId,
        freshBridgeGenerationRequested: sourceConnected,
        sourceConnected,
        readbackRequired: true,
        warning: 'mutation may have completed; underlying EDA API was not cancelled',
        diagnostic,
      };
    }

    const session = this.recoverySession;
    if (!session) {
      throw new Error('No Bridge recovery is awaiting readback.');
    }
    if (String(payload.recoveryId ?? '').trim() !== session.recoveryId) {
      throw new Error('recoveryId does not match the active recovery session.');
    }
    const targetClientId = String(payload.clientId ?? '').trim();
    if (!targetClientId || targetClientId === session.diagnostic.clientId) {
      throw new Error('clientId must identify the fresh Bridge client reported by bridge_clients.');
    }
    if (session.targetClientId && session.targetClientId !== targetClientId) {
      throw new Error(`Recovery readback is already bound to client ${session.targetClientId}.`);
    }
    const readbackPath = String(payload.readbackPath ?? '/bridge/jlceda/context');
    const readbackPayload = isRecord(payload.readbackPayload) ? payload.readbackPayload : {};
    if (!isReadOnlyRequest(readbackPath, readbackPayload)) {
      throw new Error('readbackPath and readbackPayload must describe a read-only operation; schematic layout mode=fix is not allowed.');
    }
    const target = this.peers.get(targetClientId);
    if (!target || !target.isReady || target.socket.readyState !== WebSocket.OPEN)
      throw new Error(`EDA client is not connected and ready: ${targetClientId}`);
    if (session.sourceConnected && target.connectedAt < session.requestedAtMs)
      throw new Error('clientId is not a fresh Bridge generation created after recovery was requested.');
    const expectedDocumentUuid = optionalString(payload.expectedDocumentUuid) ?? session.diagnostic.context?.documentUuid;
    const expectedProjectUuid = optionalString(payload.expectedProjectUuid) ?? session.diagnostic.context?.projectUuid;
    if (!expectedDocumentUuid && !expectedProjectUuid)
      throw new Error('Recovery requires expectedDocumentUuid or expectedProjectUuid when the original client did not report document identity.');
    if (expectedDocumentUuid && target.context?.documentUuid && target.context.documentUuid !== expectedDocumentUuid)
      throw new Error('Fresh Bridge client documentUuid does not match the expected document; writes remain blocked.');
    if (expectedProjectUuid && target.context?.projectUuid && target.context.projectUuid !== expectedProjectUuid)
      throw new Error('Fresh Bridge client projectUuid does not match the expected project; writes remain blocked.');
    this.selectClient(targetClientId, true, true);
    session.targetClientId = targetClientId;
    const readback = await this.dispatchToEda(readbackPath, readbackPayload, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
    const identityReadback = readbackPath === '/bridge/jlceda/context'
      ? readback
      : await this.dispatchToEda('/bridge/jlceda/context', {}, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
    const identity = extractReadbackIdentity(identityReadback);
    if (expectedDocumentUuid && identity.documentUuid !== expectedDocumentUuid) {
      throw new Error('Readback documentUuid does not match expectedDocumentUuid; writes remain blocked.');
    }
    if (expectedProjectUuid && identity.projectUuid !== expectedProjectUuid) {
      throw new Error('Readback projectUuid does not match expectedProjectUuid; writes remain blocked.');
    }
    this.recoverySession = undefined;
    this.recoveryDiagnostics.delete(session.diagnostic.requestId);
    return {
      ok: true,
      action,
      recoveryId: session.recoveryId,
      readbackVerified: true,
      writesRemainBlocked: hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values()),
      unresolvedMutatingRequestIds: [...this.recoveryDiagnostics.values()].filter(item => item.mutating).map(item => item.requestId),
      readback,
      identityReadback,
      warningAcknowledged: true,
    };
  }

  private async dispatchToEda(path: string, payload: unknown, timeoutMs: number, mcpSocket?: WebSocket, recoveryReadback = false, targetClientId?: string): Promise<unknown> {
    this.pruneRecoveryDiagnostics();
    const routedClientId = targetClientId ?? this.activeClientId;
    const peer = this.peers.get(routedClientId);
    if (!peer || !peer.isReady || peer.socket.readyState !== WebSocket.OPEN) {
      throw new Error('No ready EDA client connected');
    }
    if (!recoveryReadback && !isReadOnlyRequest(path, payload) && (this.recoverySession || hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values()))) {
      const recoveryId = this.recoverySession?.recoveryId ?? 'pending-timeout-diagnostics';
      throw new Error(`EDA writes are blocked pending recovery readback for ${recoveryId}.`);
    }
    const reconnectBarrier = this.getReconnectBarrier(peer.clientId);
    if (reconnectBarrier) {
      const remainingMs = Math.max(1, reconnectBarrier.until - Date.now());
      throw new Error(`EDA client is quarantined after reconnect while ${reconnectBarrier.path} may still be settling; retry in ${String(remainingMs)}ms`);
    }
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request queue timeout after ${String(BRIDGE_QUEUE_TIMEOUT_MS)}ms`));
      }, BRIDGE_QUEUE_TIMEOUT_MS);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        executionTimeoutMs: timeoutMs,
        started: false,
        clientId: peer.clientId,
        context: peer.context,
        leaseTerm: this.leaseTerm,
        mcpSocket,
        edaSocket: peer.socket,
        path,
        payload,
      });
      try {
        sendJson(peer.socket, {
          type: 'bridge/task',
          requestId,
          path,
          payload,
          createdAt: Date.now(),
          leaseTerm: this.leaseTerm,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private pruneRecoveryDiagnostics(): void {
    const cutoff = Date.now() - RECOVERY_DIAGNOSTIC_TTL_MS;
    for (const [requestId, diagnostic] of this.recoveryDiagnostics) {
      if (diagnostic.timedOutAtMs < cutoff && this.recoverySession?.diagnostic.requestId !== requestId) {
        this.recoveryDiagnostics.delete(requestId);
      }
    }
  }

  private async dispatchViaInternalClient(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.internalClient;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to main server');
    }
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      try {
        const request: BridgeTask = { type: 'bridge/task', requestId, path, payload, timeoutMs };
        sendJson(socket, request);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private createRequestId(): string {
    this.requestIdCounter += 1;
    return `req_${this.instanceId}_${this.requestIdCounter}_${Date.now()}`;
  }

  private trySend(socket: WebSocket, message: unknown): void {
    try {
      sendJson(socket, message);
    } catch (error) {
      process.stderr.write(`WebSocket send failed: ${String(error)}\n`);
    }
  }

  private rejectPendingForClient(clientId: string, reason: string): void {
    // Capture the timeout window before removing requests. EDA APIs are not
    // cancellable, so a rejected request may still be mutating the document.
    this.enterReconnectBarrier(clientId);
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.clientId !== clientId) {
        continue;
      }
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private enterReconnectBarrier(clientId: string): void {
    const pending = [...this.pendingRequests.values()]
      .filter(request => request.clientId === clientId && request.path?.startsWith('/bridge/jlceda/'));
    if (pending.length === 0) {
      return;
    }
    const longestTimeout = Math.max(...pending.map(request => request.executionTimeoutMs ?? 30000));
    const path = pending[0].path ?? '/bridge/jlceda/unknown';
    const existing = this.reconnectBarriers.get(clientId);
    const until = Date.now() + longestTimeout;
    this.reconnectBarriers.set(clientId, {
      path: existing && existing.until > until ? existing.path : path,
      until: Math.max(existing?.until ?? 0, until),
    });
  }

  private getReconnectBarrier(clientId: string): { path: string; until: number } | undefined {
    const barrier = this.reconnectBarriers.get(clientId);
    if (!barrier) {
      return undefined;
    }
    if (barrier.until <= Date.now()) {
      this.reconnectBarriers.delete(clientId);
      return undefined;
    }
    return barrier;
  }

  private rejectPendingForMcpSocket(socket: WebSocket, reason: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.mcpSocket !== socket) {
        continue;
      }
      if (pending.clientId) {
        // The MCP caller may disappear while the EDA mutation continues. Add
        // the tombstone before deleting the pending request.
        this.enterReconnectBarrier(pending.clientId);
      }
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  public close(): void {
    this.closing = true;
    if (this.peerSweepTimer) {
      clearInterval(this.peerSweepTimer);
      this.peerSweepTimer = null;
    }
    this.rejectAllPending('Bridge server closed');
    this.internalClient?.close();
    this.internalClient = null;
    for (const peer of this.peers.values()) {
      peer.socket.close(1001, 'Bridge server closed');
    }
    for (const client of this.mcpClients) {
      client.close(1001, 'Bridge server closed');
    }
    this.peers.clear();
    this.reconnectBarriers.clear();
    this.clientIdBySocket.clear();
    this.mcpClients.clear();
    this.wss?.close();
    this.wss = null;
    this.started = false;
    this.isMainServer = false;
    this.promoting = false;
  }

  public hasClients(): boolean {
    if (this.isMainServer) {
      return this.peers.size > 0;
    }
    return this.internalClient?.readyState === WebSocket.OPEN;
  }

  public getMode(): 'main' | 'client' | 'not-started' {
    if (!this.started) {
      return 'not-started';
    }
    return this.isMainServer ? 'main' : 'client';
  }
}
