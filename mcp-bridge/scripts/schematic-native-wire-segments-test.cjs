const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicConnectivityTask } = require('../src/mcp/schematic-connectivity-handler.ts');
const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');
const { handleSchematicWireManageTask } = require('../src/mcp/schematic-wire-manage-handler.ts');

// EDA 3.2.181 / API 0.3.15 实机捕获，测试运行不依赖临时文件。
// Wire.line 是同组 LINE 的独立端点对；源文档坐标的 Y 与 SDK 相反。
const NATIVE_WIRES = [{ async: true, primitiveType: 'Wire', line: [100, 200, 180, 200, 100, 200, 100, 350, 100, 500, 100, 350, 180, 500, 100, 500, 100, 540, 100, 500, 200, 540, 100, 540, 50, 350, 100, 350, 50, 450, 50, 350], net: 'MCP237_A', color: null, lineWidth: null, lineType: null, primitiveId: '4cca51de99957604' }, { async: true, primitiveType: 'Wire', line: [620, 500, 620, 200, 620, 200, 420, 200, 220, 200, 420, 200], net: 'MCP237_B', color: null, lineWidth: null, lineType: null, primitiveId: 'ca798fb365f21441' }, { async: true, primitiveType: 'Wire', line: [580, 500, 220, 500], net: '', color: null, lineWidth: null, lineType: null, primitiveId: '568be7a7cfb4c8a0' }];
const SOURCE_RECORDS = ['{"type":"WIRE","ticket":138,"id":"4cca51de99957604"}||{"zIndex":6}|', '{"type":"LINE","ticket":139,"id":"3666f6fe12908d46"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":100,"startY":-200,"endX":180,"endY":-200,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":140,"id":"22f8584a5108e91e"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":100,"startY":-200,"endX":100,"endY":-350,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":141,"id":"2843f96bac6aff25"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":100,"startY":-500,"endX":100,"endY":-350,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":142,"id":"c1bdf116b329d602"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":180,"startY":-500,"endX":100,"endY":-500,"lineGroup":"4cca51de99957604"}|', '{"type":"WIRE","ticket":145,"id":"ca798fb365f21441"}||{"zIndex":7}|', '{"type":"LINE","ticket":146,"id":"0e0bd3acdc01098f"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":620,"startY":-500,"endX":620,"endY":-200,"lineGroup":"ca798fb365f21441"}|', '{"type":"LINE","ticket":147,"id":"0b9a698a62281355"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":620,"startY":-200,"endX":420,"endY":-200,"lineGroup":"ca798fb365f21441"}|', '{"type":"LINE","ticket":148,"id":"b5066d6ae25c30d2"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":220,"startY":-200,"endX":420,"endY":-200,"lineGroup":"ca798fb365f21441"}|', '{"type":"WIRE","ticket":151,"id":"568be7a7cfb4c8a0"}||{"zIndex":8}|', '{"type":"LINE","ticket":152,"id":"87401d22783cab6b"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":580,"startY":-500,"endX":220,"endY":-500,"lineGroup":"568be7a7cfb4c8a0"}|', '{"type":"LINE","ticket":155,"id":"66223ffadeffbd8c"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":100,"startY":-540,"endX":100,"endY":-500,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":156,"id":"11c92b12dbafb7c8"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":200,"startY":-540,"endX":100,"endY":-540,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":158,"id":"a3a796c2f2faf7e6"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":50,"startY":-350,"endX":100,"endY":-350,"lineGroup":"4cca51de99957604"}|', '{"type":"LINE","ticket":159,"id":"3b7f9051cf7fa02e"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":50,"startY":-450,"endX":50,"endY":-350,"lineGroup":"4cca51de99957604"}|'];
const PAGE_UUID = '4154c79da05722b8';
const A_ID = '4cca51de99957604';

function wirePrimitive(wire) {
	return {
		getState_PrimitiveId: () => wire.primitiveId,
		getState_Line: () => wire.line,
		getState_Net: () => wire.net,
		getState_Color: () => wire.color,
		getState_LineWidth: () => wire.lineWidth,
		getState_LineType: () => wire.lineType,
	};
}

function component(id, designator, x, y, net = '') {
	return {
		getState_PrimitiveId: () => id,
		getState_ComponentType: () => net ? 'netport' : 'part',
		getState_Designator: () => designator,
		getState_Net: () => net,
		getState_X: () => x,
		getState_Y: () => y,
		getState_Name: () => 'Test resistor',
		getState_SubPartName: () => '',
	};
}

function nativeFixture() {
	const wires = new Map(structuredClone(NATIVE_WIRES).map(wire => [wire.primitiveId, wire]));
	const components = [];
	const pins = new Map();
	const nativeCalls = [];
	const wireApi = {
		async getAll() { return [...wires.values()].map(wirePrimitive); },
		async getAllPrimitiveId() { return [...wires.keys()]; },
		async modify(id, property) {
			assert.equal(this, wireApi);
			nativeCalls.push([id, structuredClone(property)]);
			Object.assign(wires.get(id), structuredClone(property));
		},
	};
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: PAGE_UUID }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: PAGE_UUID }; } },
		sch_PrimitiveWire: wireApi,
		sch_PrimitiveComponent: {
			async getAll(type) { return type ? components.filter(item => item.getState_ComponentType() === type) : components; },
			async getAllPrimitiveId() { return components.map(item => item.getState_PrimitiveId()); },
			async getAllPinsByPrimitiveId(id) { return pins.get(id) ?? []; },
		},
		sch_PrimitiveAttribute: { async getAll() { return []; } },
		sch_Drc: { async check() { return true; } },
	};
	return { wires, components, pins, nativeCalls, wireApi };
}

function checkCaptureAgainstSource() {
	const records = SOURCE_RECORDS.map((record) => {
		const [header, body] = record.split('||');
		return { ...JSON.parse(header), ...JSON.parse(body.replace(/\|$/, '')) };
	});
	assert.deepEqual(records.filter(record => record.type === 'WIRE').map(record => record.id), NATIVE_WIRES.map(wire => wire.primitiveId));
	assert.equal(records.filter(record => record.type === 'LINE').length, 12);
	for (const wire of NATIVE_WIRES) {
		const coordinates = records.filter(record => record.type === 'LINE' && record.lineGroup === wire.primitiveId)
			.flatMap(record => [record.startX, -record.startY, record.endX, -record.endY]);
		assert.deepEqual(coordinates, wire.line, '完整原生 DTO 与每条实际 LINE 记录一一对应');
	}
}

async function checkContactPreflight() {
	const fixture = nativeFixture();
	const phantom = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [140, 425, 140, 445], net: 'MCP240_NEW' });
	assert.equal(phantom.canCreate, true, '两个原生端点对之间的虚构斜线不能阻止新导线');
	assert.deepEqual(phantom.touches, []);
	assert.deepEqual(phantom.conflictingNetWireIds, []);
	const real = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [100, 425, 120, 425], net: 'MCP240_NEW', allowedWireIds: [A_ID] });
	assert.equal(real.canCreate, false, '真实 A 线段上的异网接触继续拒绝，即使已许可该 ID');
	assert.deepEqual(real.conflictingNetWireIds, [A_ID]);
	assert.deepEqual(real.touches.map(touch => touch.primitiveId), [A_ID]);
	assert.equal(fixture.nativeCalls.length, 0);
}

function pin(id, x, y) {
	return {
		getState_PrimitiveId: () => id,
		getState_PinNumber: () => '1',
		getState_PinName: () => 'A',
		getState_PinType: () => 'passive',
		getState_X: () => x,
		getState_Y: () => y,
		getState_Rotation: () => 0,
		getState_NoConnected: () => false,
	};
}

async function checkReaderPropagation() {
	const fixture = nativeFixture();
	fixture.components.push(component('real-part', 'R_REAL', 100, 425), component('phantom-part', 'R_PHANTOM', 140, 425), component('phantom-port', '', 148, 440, 'PHANTOM_PORT'));
	fixture.pins.set('real-part', [pin('real-pin', 100, 425)]);
	fixture.pins.set('phantom-part', [pin('phantom-pin', 140, 425)]);
	const read = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.equal(read.pageUuid, PAGE_UUID);
	const snapshot = JSON.parse(read.connectivityPrimitivesSnapshot);
	assert.equal(snapshot.complete, true);
	assert.equal(snapshot.wireCount, 3);
	assert.deepEqual(snapshot.wires, NATIVE_WIRES.map(({ primitiveId, net, line }) => ({ primitiveId, net, line })), '完整连接快照保留原生顺序和独立端点对');
	assert.deepEqual(snapshot.netPorts, [{ primitiveId: 'phantom-port', net: 'PHANTOM_PORT', x: 148, y: 440 }]);
	const circuit = JSON.parse(read.schematicCircuitSnapshot);
	assert.equal(circuit.components.find(item => item.componentDesignator === 'R_REAL').pins[0].connectedNetworkName, 'MCP237_A');
	assert.equal(circuit.components.find(item => item.componentDesignator === 'R_PHANTOM').pins[0].connectedNetworkName, '', '虚构对间斜线上的引脚不继承 A 网络');
	assert.equal(circuit.components.find(item => item.componentInstanceId === 'phantom-port').pins[0].connectedNetworkName, 'PHANTOM_PORT');
	assert.deepEqual(circuit.networks.find(item => item.networkName === 'MCP237_A').connectedPinRefs, ['R_REAL.1'], '幻影端口与引脚不会加入 A 网络');
	assert.equal(fixture.nativeCalls.length, 0);
}

async function checkNetOnlyAndModify() {
	const fixture = nativeFixture();
	const before = structuredClone([...fixture.wires.values()]);
	const rename = await handleSchematicWireManageTask({ action: 'modify', primitiveId: A_ID, property: { net: 'MCP240_RENAMED' } });
	assert.equal(rename.ok, true, JSON.stringify(rename));
	assert.equal(rename.verified, true);
	assert.deepEqual(fixture.nativeCalls, [[A_ID, { net: 'MCP240_RENAMED' }]], '仅改网络不会向原生重写几何或虚构路径');
	assert.deepEqual(rename.before.line, before[0].line);
	assert.deepEqual(rename.after.line, before[0].line);
	assert.deepEqual([...fixture.wires.values()].slice(1), before.slice(1));

	const requestedLine = [800, 100, 900, 100, 900, 200];
	const independentReadback = [900, 150, 900, 100, 800, 100, 850, 100, 900, 200, 900, 150, 850, 100, 900, 100];
	const originalModify = fixture.wireApi.modify;
	fixture.wireApi.modify = async function (id, property) {
		await originalModify.call(this, id, property);
		fixture.wires.get(id).line = [...independentReadback];
	};
	const modified = await handleSchematicWireManageTask({ action: 'modify', primitiveId: A_ID, property: { line: requestedLine } });
	assert.equal(modified.ok, true, JSON.stringify(modified));
	assert.equal(modified.verified, true, '连续 L 请求与原生反向、拆分、重排的独立线段几何相同');
	assert.deepEqual(fixture.nativeCalls[1], [A_ID, { line: requestedLine }], '写入仍使用官方连续路径入参');
	assert.deepEqual(modified.after.line, independentReadback, '实际独立端点对保持可见');
	assert.equal(modified.commitUnknown, undefined);
	assert.deepEqual(modified.changedOtherWireIds, []);
	assert.deepEqual([...fixture.wires.values()].slice(1), before.slice(1));
}

async function main() {
	checkCaptureAgainstSource();
	await checkContactPreflight();
	await checkReaderPropagation();
	await checkNetOnlyAndModify();
	process.stdout.write('schematic native wire segment capture tests passed\n');
}

main().catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 1;
});
