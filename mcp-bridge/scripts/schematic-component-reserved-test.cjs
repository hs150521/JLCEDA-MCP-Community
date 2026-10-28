const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleSchematicComponentEditTask: edit } = require('../src/mcp/schematic-component-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

function setup() {
	const state = {
		PrimitiveId: 'r1',
		ComponentType: 'part',
		X: 10,
		Y: 20,
		Rotation: 0,
		Mirror: false,
		Designator: 'R1',
		Name: 'R',
		UniqueId: 'u1',
		AddIntoBom: true,
		AddIntoPcb: true,
		Manufacturer: 'Maker',
		ManufacturerId: 'M1',
		Supplier: 'LCSC',
		SupplierId: 'C1',
		OtherProperty: { Value: '10k', Datasheet: 'url' },
		Component: { libraryUuid: 'lib', uuid: 'device' },
		Symbol: { libraryUuid: 'lib', uuid: 'symbol' },
		Footprint: { libraryUuid: 'lib', uuid: 'footprint' },
	};
	const fixture = { state, calls: [], effect: undefined, componentGetter: true, symbolGetter: false, footprintGetter: false };
	function primitive() {
		return Object.fromEntries(Object.keys(state).filter(key => !['Component', 'Symbol', 'Footprint'].includes(key) || fixture[`${key[0].toLowerCase() + key.slice(1)}Getter`])
			.map(key => [`getState_${key}`, () => structuredClone(state[key])]));
	}
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'page' }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'page', documentType: 1 }; } },
		sch_PrimitiveComponent: {
			async getAll() { return [primitive()]; },
			async getAllPrimitiveId() { return ['r1']; },
			async get() { return primitive(); },
			async modify(id, patch) {
				fixture.calls.push(structuredClone(patch));
				for (const [key, value] of Object.entries(patch))
					state[key[0].toUpperCase() + key.slice(1)] = structuredClone(value);
				fixture.effect?.(patch);
				return primitive();
			},
		},
	};
	return fixture;
}
const modify = property => edit({ action: 'modify', primitiveId: 'r1', property });
async function main() {
	for (const [key, canonical] of [
		['Device', 'library'],
		['Footprint', 'library'],
		['Symbol', 'library'],
		['Supplier Part', 'supplierId'],
		['Manufacturer', 'manufacturer'],
		['Manufacturer Part', 'manufacturerId'],
		['Supplier', 'supplier'],
	]) {
		const f = setup();
		await assert.rejects(modify({ otherProperty: { [key]: 'bad' } }), error => error.message.includes(key) && error.message.includes(canonical));
		assert.equal(f.calls.length, 0, `reserved ${key} must fail before native write`);
	}
	let f = setup();
	f.state.OtherProperty = { ...f.state.OtherProperty, 'Device': 'existing-device', 'Footprint': 'existing-fp', 'Symbol': 'existing-symbol', 'Supplier Part': 'C1' };
	let result = await modify({ supplierId: 'C2', otherProperty: { Value: '22k' } });
	assert.equal(result.ok, true);
	assert.deepEqual(f.calls[0].otherProperty, { Value: '22k', Datasheet: 'url' });
	assert.deepEqual(result.after.component, { libraryUuid: 'lib', uuid: 'device' });
	assert.deepEqual(result.bindingVerification.unavailable, ['symbol', 'footprint']);
	assert.equal(result.bindingVerification.verified, false);
	f = setup();
	f.effect = () => {
		f.state.Component.uuid = 'corrupted';
	};
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'post_write_readback_mismatch');
	assert.equal(result.after.component.uuid, 'corrupted');
	assert.ok(result.mismatches.some(m => m.key === 'component.uuid' && m.expected === 'device' && m.actual === 'corrupted'));
	assert.deepEqual([result.commitUnknown, result.readbackRequired, result.nativeCallSettled], [true, true, true]);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/component-edit', { action: 'modify' }, result), false);
	f = setup();
	f.effect = () => {
		delete f.state.OtherProperty.Value;
		f.state.SupplierId = 'wrong';
	};
	result = await modify({ supplierId: 'C2', otherProperty: { Value: '22k' } });
	assert.equal(result.after.supplierId, 'wrong');
	assert.ok(result.mismatches.some(m => m.key === 'supplierId' && m.expected === 'C2' && m.actual === 'wrong'));
	assert.ok(result.mismatches.some(m => m.key === 'otherProperty.Value' && m.expected === '22k' && m.actual === null));
	for (const [native, canonical] of [
		['SupplierId', 'supplierId'],
		['Supplier', 'supplier'],
		['Manufacturer', 'manufacturer'],
		['ManufacturerId', 'manufacturerId'],
		['Designator', 'designator'],
		['Name', 'name'],
		['UniqueId', 'uniqueId'],
		['AddIntoBom', 'addIntoBom'],
		['AddIntoPcb', 'addIntoPcb'],
	]) {
		f = setup();
		f.state.OtherProperty = { ...f.state.OtherProperty, 'Supplier Part': 'C1', 'Manufacturer': 'Maker' };
		const expected = f.state[native];
		// Keep the public getter present while simulating an attribute cleared by the native write.
		f.effect = () => {
			f.state[native] = undefined;
		};
		result = await modify({ otherProperty: { Value: '22k' } });
		assert.equal(result.ok, false, `an unrelated ${canonical} must survive custom metadata updates`);
		assert.equal(result.reason, 'post_write_readback_mismatch');
		assert.ok(result.mismatches.some(m => m.key === canonical && m.expected === expected && m.actual === null));
	}
	f = setup();
	f.state.Supplier = undefined;
	f.effect = () => {
		f.state.Supplier = null;
	};
	result = await modify({ otherProperty: { Value: '22k' } });
	assert.equal(result.ok, true, 'native undefined/null normalization of optional attributes is harmless');
	f = setup();
	f.componentGetter = false;
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, true);
	assert.deepEqual(result.bindingVerification.unavailable, ['component', 'symbol', 'footprint']);
	f = setup();
	f.effect = () => {
		f.componentGetter = false;
	};
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, false);
	assert.ok(result.mismatches.some(m => m.key === 'component' && m.reason === 'binding_unreadable'));

	f = setup();
	f.symbolGetter = true;
	f.footprintGetter = true;
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.ok, true);
	assert.deepEqual(result.after.symbol, { libraryUuid: 'lib', uuid: 'symbol' });
	assert.deepEqual(result.after.footprint, { libraryUuid: 'lib', uuid: 'footprint' });
	assert.deepEqual(result.bindingVerification, { verified: true, checked: ['component', 'symbol', 'footprint'], unavailable: [] }, 'all public v4 getters participate in binding verification');

	for (const key of ['Component', 'Symbol', 'Footprint']) {
		const lower = key[0].toLowerCase() + key.slice(1);
		f = setup();
		f.symbolGetter = true;
		f.footprintGetter = true;
		f.effect = () => {
			f.state[key].uuid = 'corrupted';
		};
		result = await modify({ supplierId: 'C2' });
		assert.equal(result.ok, false, `${key} changes must not pass verification`);
		assert.equal(result.reason, 'post_write_readback_mismatch');
		assert.equal(result.bindingVerification.verified, false);
		assert.ok(result.mismatches.some(m => m.key === `${lower}.uuid` && m.actual === 'corrupted'));

		f = setup();
		f.symbolGetter = true;
		f.footprintGetter = true;
		f.effect = () => {
			f[`${lower}Getter`] = false;
		};
		result = await modify({ supplierId: 'C2' });
		assert.equal(result.ok, false, `losing ${key} readback must not pass verification`);
		assert.ok(result.mismatches.some(m => m.key === lower && m.reason === 'binding_unreadable'));
		assert.ok(result.bindingVerification.unavailable.includes(lower));

		f = setup();
		f.symbolGetter = true;
		f.footprintGetter = true;
		f.state[key] = undefined;
		result = await modify({ supplierId: 'C2' });
		assert.equal(result.ok, true);
		assert.equal(result.bindingVerification.verified, true, `undefined ${key} is the documented unbound state`);
		f.effect = () => {
			f.state[key] = { libraryUuid: 'lib', uuid: 'unexpected' };
		};
		result = await modify({ supplierId: 'C3' });
		assert.equal(result.ok, false, `an unexpected ${key} binding must be detected`);
		assert.ok(result.mismatches.some(m => m.key === lower && m.expected === null && m.actual.uuid === 'unexpected'));
	}

	f = setup();
	f.symbolGetter = true;
	f.footprintGetter = true;
	f.state.Symbol = { libraryUuid: '', uuid: '' };
	result = await modify({ supplierId: 'C2' });
	assert.equal(result.bindingVerification.verified, false);
	assert.deepEqual(result.bindingVerification.unavailable, ['symbol'], 'malformed bindings are not treated as verified');
	console.log('Schematic reserved binding and mismatch regressions passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
