import { isPlainObjectRecord } from '../utils.ts';

const RESERVED: Record<string, string> = {
	'Device': 'library binding; an explicit validated library rebind is required',
	'Footprint': 'library binding; an explicit validated library rebind is required',
	'Symbol': 'library binding; an explicit validated library rebind is required',
	'Supplier Part': 'supplierId',
	'Manufacturer': 'manufacturer',
	'Manufacturer Part': 'manufacturerId',
	'Supplier': 'supplier',
};

/** Native schematic metadata aliases may write hidden source bindings. */
export function validateSchematicMetadataPatch(value: unknown): void {
	if (!isPlainObjectRecord(value))
		throw new TypeError('otherProperty must be an object.');
	for (const key of Object.keys(value)) {
		if (Object.hasOwn(RESERVED, key))
			throw new TypeError(`Reserved schematic otherProperty.${key}; use canonical ${RESERVED[key]}.`);
	}
}

/** Preserve custom metadata without replaying host-managed attributes. */
export function safeSchematicMetadata(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(RESERVED, key)));
}
