import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type TimeoutPolicyName = 'default' | 'api' | 'standard-read' | 'extended-read' | 'batch-write';

interface TimeoutPolicy {
  defaultMs: number;
  minMs: number;
  maxMs: number;
  allowOverride: boolean;
}

export interface BridgeOperation {
  toolName?: string;
  path: string;
  owner: 'server' | 'bridge';
  timeoutPolicy?: TimeoutPolicyName;
  readOnly?: boolean;
  readOnlyIf?: { field: string; equals: unknown; defaultValue?: unknown };
  readOnlyUnless?: { field: string; equals: unknown };
  readOnlyIfNoArgsApiFullNames?: string[];
  readOnlyIfCurrentPageArgsApiFullNames?: string[];
}

interface BridgeContract {
  contractVersion: string;
  footprintApi: { readOnlyApiFullNames: string[]; mutatingApiFullNames: string[] };
  protocol: { version: number; clientMessages: Record<string, MessageShape>; serverMessages: Record<string, MessageShape> };
  timeoutPolicies: Record<TimeoutPolicyName, TimeoutPolicy>;
  operations: BridgeOperation[];
  internalOperations: BridgeOperation[];
}

interface MessageShape {
  required: Record<string, FieldKind>;
  optional?: Record<string, FieldKind>;
}

type FieldKind = 'any' | 'bridge-path' | 'context' | 'debug-switch' | 'finite-number' | 'non-empty-string' | 'non-negative-integer' | 'positive-integer' | 'record' | 'role' | 'string' | 'task-error' | 'schematic-pin-adapter';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const contractPath = join(currentDirectory, '..', 'resources', 'bridge-contract.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadContract(): BridgeContract {
  const parsed = JSON.parse(readFileSync(contractPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.contractVersion !== 'string' || !isRecord(parsed.protocol)
    || !Number.isInteger(parsed.protocol.version) || !Array.isArray(parsed.operations)
    || !Array.isArray(parsed.internalOperations) || !isRecord(parsed.timeoutPolicies)) {
    throw new Error('Invalid bridge-contract.json');
  }
  return parsed as unknown as BridgeContract;
}

export const BRIDGE_CONTRACT = loadContract();
export const BRIDGE_PROTOCOL_VERSION = BRIDGE_CONTRACT.protocol.version;
export const BRIDGE_OPERATIONS = [...BRIDGE_CONTRACT.operations, ...BRIDGE_CONTRACT.internalOperations] as const;
export const BRIDGE_ROUTES = Object.freeze(Object.fromEntries(
  BRIDGE_CONTRACT.operations.filter(operation => operation.toolName).map(operation => [operation.toolName!, operation.path]),
));

const operationByPath = new Map(BRIDGE_OPERATIONS.map(operation => [operation.path, operation]));
const operationByTool = new Map(BRIDGE_CONTRACT.operations.filter(operation => operation.toolName).map(operation => [operation.toolName!, operation]));

const footprintReadApis = new Set(BRIDGE_CONTRACT.footprintApi.readOnlyApiFullNames.map(name => name.toLowerCase()));
const footprintWriteApis = new Set(BRIDGE_CONTRACT.footprintApi.mutatingApiFullNames.map(name => name.toLowerCase()));

export function footprintApiAccess(apiFullName: unknown): 'read' | 'write' | undefined {
  if (typeof apiFullName !== 'string') return undefined;
  const name = apiFullName.trim().toLowerCase();
  return footprintReadApis.has(name) ? 'read' : footprintWriteApis.has(name) ? 'write' : undefined;
}

export function operationForPath(path: string): BridgeOperation | undefined {
  return operationByPath.get(path);
}

export function operationForTool(toolName: string): BridgeOperation | undefined {
  return operationByTool.get(toolName);
}

export function bridgePathForTool(toolName: string): string {
  const operation = operationForTool(toolName);
  if (!operation) {
    throw new Error(`Unknown Bridge tool: ${toolName}`);
  }
  return operation.path;
}

export function bridgeTimeoutForTool(toolName: string, payload: Record<string, unknown>): number | undefined {
  const operation = operationForTool(toolName);
  const policyName = operation?.timeoutPolicy;
  if (!policyName) {
    return undefined;
  }
  const policy = BRIDGE_CONTRACT.timeoutPolicies[policyName];
  if (!policy.allowOverride) {
    return policy.defaultMs;
  }
  if (payload.timeoutMs === undefined) {
    return policy.defaultMs;
  }
  const timeoutMs = Number(payload.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < policy.minMs || timeoutMs > policy.maxMs) {
    throw new RangeError(`timeoutMs must be an integer between ${String(policy.minMs)} and ${String(policy.maxMs)}`);
  }
  return timeoutMs;
}

export function isReadOnlyBridgeRequest(path: string, payload: unknown): boolean {
  if (path === '/bridge/jlceda/api/invoke' && isRecord(payload) && footprintApiAccess(payload.apiFullName) === 'read')
    return true;
  const operation = operationForPath(path);
  if (operation?.readOnlyIfNoArgsApiFullNames || operation?.readOnlyIfCurrentPageArgsApiFullNames) {
    if (!isRecord(payload)) return false;
    const apiFullName = String(payload.apiFullName ?? '').trim().toLowerCase();
    const args = payload.args;
    const noArgs = !Array.isArray(args) || args.length === 0;
    const currentPageArgs = Array.isArray(args) && args.length === 2 && args[0] === null && args[1] === false;
    return (noArgs && (operation.readOnlyIfNoArgsApiFullNames?.some(name => name.toLowerCase() === apiFullName) ?? false))
      || (currentPageArgs && (operation.readOnlyIfCurrentPageArgsApiFullNames?.some(name => name.toLowerCase() === apiFullName) ?? false));
  }
  if (operation?.readOnlyIf) {
    const condition = operation.readOnlyIf;
    const value = isRecord(payload) ? payload[condition.field] ?? condition.defaultValue : undefined;
    return Array.isArray(condition.equals) ? condition.equals.includes(value) : value === condition.equals;
  }
  if (!operation?.readOnly) {
    return false;
  }
  if (!operation.readOnlyUnless) {
    return true;
  }
  return !isRecord(payload) || payload[operation.readOnlyUnless.field] !== operation.readOnlyUnless.equals;
}

function fieldMatches(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'schematic-pin-adapter': return value === 'component_pin_instance' || value === 'native_pin';
    case 'any': return true;
    case 'string': return typeof value === 'string';
    case 'non-empty-string': return typeof value === 'string' && value.trim().length > 0;
    case 'finite-number': return typeof value === 'number' && Number.isFinite(value);
    case 'non-negative-integer': return Number.isInteger(value) && Number(value) >= 0;
    case 'positive-integer': return Number.isInteger(value) && Number(value) > 0;
    case 'record': return isRecord(value);
    case 'role': return value === 'active' || value === 'standby';
    case 'bridge-path': return typeof value === 'string' && operationByPath.has(value);
    case 'context': {
      if (value === undefined) return true;
      if (!isRecord(value)) return false;
      const stringFields = ['documentUuid', 'tabId', 'projectUuid', 'projectName', 'pageUuid', 'pageName', 'libraryUuid'];
      return (value.documentType === undefined || (typeof value.documentType === 'number' && Number.isFinite(value.documentType)))
        && (value.pageKind === undefined || value.pageKind === 'schematic' || value.pageKind === 'pcb' || value.pageKind === 'footprint')
        && stringFields.every(field => value[field] === undefined || typeof value[field] === 'string');
    }
    case 'debug-switch': return isRecord(value) && typeof value.enableSystemLog === 'boolean' && typeof value.enableConnectionList === 'boolean';
    case 'task-error': return isRecord(value) && typeof value.message === 'string';
  }
}

function validateMessage(value: unknown, shapes: Record<string, MessageShape>): string | undefined {
  if (!isRecord(value)) {
    return 'Bridge message must be an object';
  }
  const type = typeof value.type === 'string' ? value.type : '';
  const shape = shapes[type];
  if (!shape) {
    return `Unsupported bridge message type: ${type || '(missing)'}`;
  }
  for (const [field, kind] of Object.entries(shape.required)) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || !fieldMatches(kind, value[field])) {
      return `Invalid ${type} field: ${field}`;
    }
  }
  for (const [field, kind] of Object.entries(shape.optional ?? {})) {
    if (value[field] !== undefined && !fieldMatches(kind, value[field])) {
      return `Invalid ${type} field: ${field}`;
    }
  }
  return undefined;
}

export function validateBridgeClientMessage(value: unknown): string | undefined {
  return validateMessage(value, BRIDGE_CONTRACT.protocol.clientMessages);
}

export function validateBridgeServerMessage(value: unknown): string | undefined {
  return validateMessage(value, BRIDGE_CONTRACT.protocol.serverMessages);
}
