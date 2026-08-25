import contract from '../resources/bridge-contract.json';

export interface BridgeOperation {
	toolName?: string;
	path: string;
	owner: 'server' | 'bridge';
	timeoutPolicy?: 'default' | 'api' | 'standard-read' | 'extended-read';
	readOnly?: boolean;
	readOnlyUnless?: { field: string; equals: unknown };
}

type FieldKind = 'any' | 'bridge-path' | 'context' | 'debug-switch' | 'finite-number' | 'non-empty-string' | 'non-negative-integer' | 'positive-integer' | 'record' | 'role' | 'string' | 'task-error';
interface MessageShape {
	required: Record<string, FieldKind>;
	optional?: Record<string, FieldKind>;
}

export const BRIDGE_CONTRACT = contract as {
	contractVersion: string;
	protocol: { version: number; clientMessages: Record<string, MessageShape>; serverMessages: Record<string, MessageShape> };
	timeoutPolicies: Record<'default' | 'api' | 'standard-read' | 'extended-read', { defaultMs: number; minMs: number; maxMs: number; allowOverride: boolean }>;
	operations: BridgeOperation[];
	internalOperations: BridgeOperation[];
};

export const BRIDGE_PROTOCOL_VERSION = BRIDGE_CONTRACT.protocol.version;
export const BRIDGE_OPERATIONS = [...BRIDGE_CONTRACT.operations, ...BRIDGE_CONTRACT.internalOperations] as const;
export const BRIDGE_TOOL_ROUTES = Object.freeze(Object.fromEntries(
	BRIDGE_CONTRACT.operations.filter(operation => operation.toolName).map(operation => [operation.toolName!, operation.path]),
));

const operationByPath = new Map(BRIDGE_OPERATIONS.map(operation => [operation.path, operation]));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function operationForBridgePath(path: string): BridgeOperation | undefined {
	return operationByPath.get(path);
}

export function bridgePathForTool(toolName: string): string {
	const path = BRIDGE_TOOL_ROUTES[toolName];
	if (!path) {
		throw new Error(`Unknown Bridge tool: ${toolName}`);
	}
	return path;
}

export function resolveContractTimeoutMs(path: string, payload: unknown): number {
	const policyName = operationForBridgePath(path)?.timeoutPolicy ?? 'default';
	const policy = BRIDGE_CONTRACT.timeoutPolicies[policyName];
	if (!policy.allowOverride || !isRecord(payload) || payload.timeoutMs === undefined) {
		return policy.defaultMs;
	}
	const timeoutMs = Number(payload.timeoutMs);
	if (!Number.isInteger(timeoutMs) || timeoutMs < policy.minMs || timeoutMs > policy.maxMs) {
		throw new RangeError(`timeoutMs must be an integer between ${String(policy.minMs)} and ${String(policy.maxMs)}`);
	}
	return timeoutMs;
}

function fieldMatches(kind: FieldKind, value: unknown): boolean {
	switch (kind) {
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
			if (value === undefined) {
				return true;
			}
			if (!isRecord(value)) {
				return false;
			}
			const stringFields = ['documentUuid', 'tabId', 'projectUuid', 'projectName', 'pageUuid', 'pageName'];
			return (value.documentType === undefined || (typeof value.documentType === 'number' && Number.isFinite(value.documentType)))
				&& (value.pageKind === undefined || value.pageKind === 'schematic' || value.pageKind === 'pcb')
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

export function validateBridgeServerMessage(value: unknown): string | undefined {
	return validateMessage(value, BRIDGE_CONTRACT.protocol.serverMessages);
}
