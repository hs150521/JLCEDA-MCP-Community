import type { BridgeClientContext } from './protocol.ts';
import { isPlainObjectRecord } from '../utils.ts';

export interface FootprintIdentity {
	pageKind: 'footprint';
	documentType: 4;
	documentUuid: string;
	pageUuid: string;
	libraryUuid: string;
	tabId: string;
}

export function editorDocumentPageKind(document: unknown): BridgeClientContext['pageKind'] {
	if (!isPlainObjectRecord(document))
		return undefined;
	switch (document.documentType) {
		case 1: return 'schematic';
		case 3: return 'pcb';
		case 4: return 'footprint';
		default: return undefined;
	}
}

export async function readCurrentEditorDocument(runtime: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
	const api = runtime.dmt_SelectControl;
	if (!isPlainObjectRecord(api) || typeof api.getCurrentDocumentInfo !== 'function')
		return undefined;
	const document = await (api.getCurrentDocumentInfo as () => Promise<unknown>).call(api);
	return isPlainObjectRecord(document) ? document : undefined;
}

function requiredIdentity(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`Current footprint ${name} is unavailable.`);
	return value.trim();
}

/** 封装身份只来自当前库文档，不读取可能残留的 PCB 或工程上下文。 */
export function footprintIdentityFromDocument(document: unknown): FootprintIdentity {
	if (!isPlainObjectRecord(document) || editorDocumentPageKind(document) !== 'footprint')
		throw new TypeError('Current editor is not a footprint document.');
	const documentUuid = requiredIdentity(document.uuid, 'document UUID');
	return {
		pageKind: 'footprint',
		documentType: 4,
		documentUuid,
		pageUuid: documentUuid,
		libraryUuid: requiredIdentity(document.parentLibraryUuid, 'library UUID'),
		tabId: requiredIdentity(document.tabId, 'tab ID'),
	};
}

export async function readFootprintIdentity(runtime: Record<string, unknown>): Promise<FootprintIdentity> {
	return footprintIdentityFromDocument(await readCurrentEditorDocument(runtime));
}

/** 新恢复会话可使用新的标签页；单次调用仍核对其开始时的标签页。 */
export async function assertFootprintIdentity(runtime: Record<string, unknown>, expected: FootprintIdentity): Promise<void> {
	const actual = await readFootprintIdentity(runtime);
	if (actual.documentUuid !== expected.documentUuid || actual.pageUuid !== expected.pageUuid
		|| actual.libraryUuid !== expected.libraryUuid || actual.tabId !== expected.tabId) {
		throw new Error('The active footprint library, document, or tab changed during the operation.');
	}
}
