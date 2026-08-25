import { timingSafeEqual } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

export const BRIDGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function decodeBridgeMessage(data: RawData): unknown {
	if (Buffer.isBuffer(data)) {
		return JSON.parse(data.toString('utf8'));
	}
	if (Array.isArray(data)) {
		return JSON.parse(Buffer.concat(data).toString('utf8'));
	}
	return JSON.parse(Buffer.from(data).toString('utf8'));
}

export function sendBridgeJson(socket: WebSocket, message: unknown): void {
	if (socket.readyState !== WebSocket.OPEN) {
		throw new Error('WebSocket is not open');
	}
	const payload = JSON.stringify(message);
	if (Buffer.byteLength(payload, 'utf8') > BRIDGE_MAX_PAYLOAD_BYTES) {
		throw new Error(`WebSocket payload exceeds ${String(BRIDGE_MAX_PAYLOAD_BYTES)} bytes`);
	}
	socket.send(payload);
}

export function tokensMatch(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
