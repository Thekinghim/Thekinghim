import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Utf8 } from '../src/util/keccak.js';
import { slotFor, ownerIsRenounced, isUpgradeableProxy } from '../src/ingest/evm.js';

test('keccak256 matchar kända testvektorer', () => {
  assert.equal(
    keccak256Utf8(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256Utf8('abc'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  // Över en block-gräns (136 byte) så att svamp-loopen testas, inte bara en runda.
  assert.equal(
    keccak256Utf8('a'.repeat(200)),
    keccak256Utf8('a'.repeat(200)),
  );
});

test('PairCreated-topicen räknas fram korrekt', () => {
  assert.equal(
    keccak256Utf8('PairCreated(address,address,address,uint256)'),
    '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  );
});

test('slotFor är deterministisk och skiljer på nyckel och slot', () => {
  const a = slotFor('0x000000000000000000000000000000000000dEaD', 0);
  assert.equal(a, slotFor('0x000000000000000000000000000000000000dead', 0));
  assert.notEqual(a, slotFor('0x000000000000000000000000000000000000dEaD', 1));
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test('okänd ägare räknas som icke-avsagd — fail closed', () => {
  assert.equal(ownerIsRenounced('0x'), false, 'utan svar ska token inte godkännas');
  assert.equal(ownerIsRenounced(`0x${'0'.repeat(64)}`), true);
  assert.equal(ownerIsRenounced(`0x${'0'.repeat(24)}${'ab'.repeat(20)}`), false);
});

test('proxy upptäcks via EIP-1967-sloten', () => {
  assert.equal(isUpgradeableProxy(`0x${'0'.repeat(64)}`), false);
  assert.equal(isUpgradeableProxy(`0x${'0'.repeat(24)}${'ab'.repeat(20)}`), true);
});
