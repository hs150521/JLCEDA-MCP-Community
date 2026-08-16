const assert = require('node:assert/strict');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { detectNetLabelKind } = require('../src/mcp/netlabel-place-handler.ts');

for (const name of ['UART_TX', 'SPI_CLK', 'BLUE_LED_DATA']) {
	assert.equal(detectNetLabelKind(name), 'NetLabel', `${name} must use an ordinary net label`);
}
for (const name of ['VCC', '+5V', 'FIELD_12V', '3V3']) {
	assert.equal(detectNetLabelKind(name), 'Power', `${name} must use a power net flag`);
}
assert.equal(detectNetLabelKind('GND'), 'Ground');
assert.equal(detectNetLabelKind('AGND'), 'AnalogGround');
assert.equal(detectNetLabelKind('PE'), 'ProtectGround');

process.stdout.write('Net label classification test passed\n');
